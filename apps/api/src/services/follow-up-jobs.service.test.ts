import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, intakeLinkTokensTable, followUpJobsTable, questionnaireEventsTable, purchasesTable } from "@luma/db";
import { hashToken } from "../lib/crypto.js";
import { sweepFollowUpJobs } from "./follow-up-jobs.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Test",
      lastName: "Lead",
      email: `lead-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
    })
    .returning({ id: customersTable.id });
  return row.id;
}

/** Seeds a clicked token + a pending job due at `dueAt`, clicked at `clickedAt`. */
async function seedPendingJob(personId: string, clickedAt: Date, dueAt: Date) {
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
    .values({
      personId,
      intakeLinkTokenId: token.id,
      dueAt,
    })
    .returning({ id: followUpJobsTable.id });

  return job.id;
}

describe("sweepFollowUpJobs", () => {
  it("leaves not-yet-due jobs untouched", async () => {
    const personId = await seedCustomer();
    const jobId = await seedPendingJob(personId, new Date(Date.now() - 60_000), new Date(Date.now() + 60 * 60 * 1000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("pending");
  });

  it("flips a due job to ready when the person has not completed the questionnaire or purchased", async () => {
    const personId = await seedCustomer();
    const jobId = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const result = await sweepFollowUpJobs();

    expect(result.readyCount).toBeGreaterThanOrEqual(1);
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("ready");
    expect(job.readyAt).not.toBeNull();
  });

  it("cancels a due job when the person submitted the questionnaire after clicking", async () => {
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const jobId = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await db.insert(questionnaireEventsTable).values({
      personId,
      questionnaireId: "q-1",
      status: "submitted",
      lastEventAt: new Date(clickedAt.getTime() + 30 * 60 * 1000),
    });

    const result = await sweepFollowUpJobs();

    expect(result.cancelledCount).toBeGreaterThanOrEqual(1);
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("cancelled");
    expect(job.cancelledReason).toBe("completed_before_followup");
  });

  it("cancels a due job when the person completed a purchase after clicking", async () => {
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const jobId = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

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

  it("does not reprocess a job that is already ready or cancelled", async () => {
    const personId = await seedCustomer();
    const jobId = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();
    const [afterFirst] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(afterFirst.status).toBe("ready");
    const firstReadyAt = afterFirst.readyAt;

    await sweepFollowUpJobs();
    const [afterSecond] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(afterSecond.readyAt?.getTime()).toBe(firstReadyAt?.getTime());
  });

  it("ignores a questionnaire submission that happened before the link was clicked", async () => {
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Stale completion from a prior, unrelated questionnaire — well before this click.
    await db.insert(questionnaireEventsTable).values({
      personId,
      questionnaireId: "q-old",
      status: "submitted",
      lastEventAt: new Date(clickedAt.getTime() - 24 * 60 * 60 * 1000),
    });

    const jobId = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("ready");
  });
});
