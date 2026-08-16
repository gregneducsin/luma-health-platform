import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, intakeLinkTokensTable, followUpJobsTable, questionnaireEventsTable, purchasesTable } from "@luma/db";
import { hashToken } from "../lib/crypto.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return {
    ...actual,
    getSmsProvider: () => ({ sendMessage: sendMessageMock }),
  };
});

const { sweepFollowUpJobs } = await import("./follow-up-jobs.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Test",
      lastName: "Lead",
      email: `lead-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15551234567" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

/** Seeds a clicked token + a pending job due at `dueAt`, clicked at `clickedAt`. */
async function seedPendingJob(
  personId: string,
  clickedAt: Date,
  dueAt: Date,
  messageStep: "provider_check_in" | "intake_questions_check_in" = "provider_check_in",
) {
  const [token] = await db
    .insert(intakeLinkTokensTable)
    .values({
      personId,
      tokenHash: hashToken(`token-${crypto.randomUUID()}`),
      expiresAt: new Date(clickedAt.getTime() + 24 * 60 * 60 * 1000),
      clickedAt,
    })
    .returning({ id: intakeLinkTokensTable.id });

  const [job] = await db
    .insert(followUpJobsTable)
    .values({ personId, intakeLinkTokenId: token.id, messageStep, dueAt })
    .returning({ id: followUpJobsTable.id });

  return { jobId: job.id, tokenId: token.id };
}

describe("sweepFollowUpJobs", () => {
  it("leaves not-yet-due jobs untouched", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 60_000), new Date(Date.now() + 60 * 60 * 1000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("pending");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends the provider_check_in message and schedules intake_questions_check_in 1 hour later on success", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_123" });
    const personId = await seedCustomer({ phone: "+15559876543" });
    const { jobId, tokenId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const result = await sweepFollowUpJobs();

    expect(result.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15559876543", expect.stringContaining("Should I go ahead and let the doctors know"));

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("sent");
    expect(job.sentAt).not.toBeNull();
    expect(job.providerMessageId).toBe("msg_123");

    const nextJobs = await db
      .select()
      .from(followUpJobsTable)
      .where(eq(followUpJobsTable.intakeLinkTokenId, tokenId));
    const step2 = nextJobs.find((j) => j.messageStep === "intake_questions_check_in");
    expect(step2).toBeDefined();
    expect(step2!.status).toBe("pending");
    const dueInMs = new Date(step2!.dueAt).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(60 * 60 * 1000 - 5000);
    expect(dueInMs).toBeLessThan(60 * 60 * 1000 + 5000);
  });

  it("does not schedule a third message after intake_questions_check_in sends", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_456" });
    const personId = await seedCustomer();
    const { tokenId } = await seedPendingJob(
      personId,
      new Date(Date.now() - 4 * 60 * 60 * 1000),
      new Date(Date.now() - 60_000),
      "intake_questions_check_in",
    );

    await sweepFollowUpJobs();

    const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.intakeLinkTokenId, tokenId));
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("sent");
  });

  it("cancels a due job when the person submitted the questionnaire after clicking", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await db.insert(questionnaireEventsTable).values({
      personId,
      questionnaireId: "q-1",
      status: "submitted",
      lastEventAt: new Date(clickedAt.getTime() + 30 * 60 * 1000),
    });

    const result = await sweepFollowUpJobs();

    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("cancelled");
    expect(job.cancelledReason).toBe("completed_before_followup");
  });

  it("cancels a due job when the person completed a purchase after clicking", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("cancelled");
  });

  it("ignores a questionnaire submission that happened before the link was clicked", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_789" });
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);

    await db.insert(questionnaireEventsTable).values({
      personId,
      questionnaireId: "q-old",
      status: "submitted",
      lastEventAt: new Date(clickedAt.getTime() - 24 * 60 * 60 * 1000),
    });

    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("sent");
  });

  it("marks a job failed with NO_PHONE_NUMBER when the customer has no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    expect(sendMessageMock).not.toHaveBeenCalled();
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("marks a job failed and does not schedule step 2 when the send itself throws", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_PROVIDER_UNAVAILABLE"));
    const personId = await seedCustomer();
    const { jobId, tokenId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const result = await sweepFollowUpJobs();

    expect(result.failedCount).toBe(1);
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("SMS_PROVIDER_UNAVAILABLE");

    const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.intakeLinkTokenId, tokenId));
    expect(jobs.length).toBe(1);
  });

  it("does not reprocess a job that already resolved", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_first" });
    const personId = await seedCustomer();
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();
    const [afterFirst] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(afterFirst.status).toBe("sent");

    await sweepFollowUpJobs();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
