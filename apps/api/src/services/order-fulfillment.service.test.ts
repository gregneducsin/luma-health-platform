import { describe, expect, it, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, reviewRequestTriggersTable } from "@luma/db";
import { setCustomerSmsDnd } from "./dnd.service.js";

beforeAll(() => {
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: (persona: "lucy" | "sarah") => ({ provider: { sendEmail: sendEmailMock }, fromName: `${persona} at Luma Health` }) };
});

const { sendOrderReceivedOpener, handlePrescriptionWritten, handleOrderShipped, sweepReviewRequestTriggers } = await import(
  "./order-fulfillment.service.js"
);
const { getOrCreateSupportConversation, listSupportMessages } = await import("./support-conversations.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Fulfillment",
      lastName: "Test",
      email: `fulfillment-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
      phone: opts.phone === undefined ? "+15559991111" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function backdateTrigger(personId: string) {
  await db.update(reviewRequestTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(reviewRequestTriggersTable.personId, personId));
}

async function getCustomerEmail(personId: string): Promise<string> {
  const [row] = await db.select({ email: customersTable.email }).from(customersTable).where(eq(customersTable.id, personId));
  return row.email;
}

describe("sendOrderReceivedOpener", () => {
  it("sends the order-received message and logs it", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_opener" });

    const personId = await seedCustomer();
    await sendOrderReceivedOpener(personId);

    expect(sendMessageMock).toHaveBeenCalledWith("+15559991111", expect.stringContaining("this is Sarah"));
    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].providerMessageId).toBe("msg_opener");
  });

  it("also sends an order-received email alongside the text", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_opener_email_sibling" });
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<order-received@example.com>" });

    const personId = await seedCustomer();
    const email = await getCustomerEmail(personId);
    await sendOrderReceivedOpener(personId);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toBe(email);
  });

  it("does not call the SMS provider when there's no phone on file, but still sends the email", async () => {
    sendMessageMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<order-received-no-phone@example.com>" });
    const personId = await seedCustomer({ phone: null });
    await sendOrderReceivedOpener(personId);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("does not call the SMS provider when the customer is SMS do-not-disturb, but still sends the email", async () => {
    sendMessageMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<order-received-sms-dnd@example.com>" });
    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);
    await sendOrderReceivedOpener(personId);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("handlePrescriptionWritten", () => {
  it("updates the conversation state and sends the notice", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_prescription" });

    const personId = await seedCustomer();
    await handlePrescriptionWritten(personId);

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.prescriptionWritten).toBe(true);
    expect(conversation.prescriptionWrittenAt).not.toBeNull();
    const messages = await listSupportMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].body).toContain("prescription");
  });

  it("also sends a prescription-written email alongside the text", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_prescription_email_sibling" });
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<prescription-written@example.com>" });

    const personId = await seedCustomer();
    const email = await getCustomerEmail(personId);
    await handlePrescriptionWritten(personId);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toBe(email);
  });

  it("still updates state when there's no phone on file, but sends nothing", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    await handlePrescriptionWritten(personId);

    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.prescriptionWritten).toBe(true);
  });
});

describe("handleOrderShipped", () => {
  it("updates the conversation state with the tracking number, sends the notice, and arms the review-request trigger", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" });

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK123456");

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.orderShipped).toBe(true);
    expect(conversation.trackingNumber).toBe("TRACK123456");
    const messages = await listSupportMessages(conversation.id);
    expect(messages[0].body).toContain("TRACK123456");

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger).toBeDefined();
    expect(trigger.status).toBe("pending");
  });

  it("is idempotent — a second shipped event for the same person does not create a second review-request trigger", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_shipped" });

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK1");
    await handleOrderShipped(personId, "TRACK2");

    const triggers = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(triggers.length).toBe(1);

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.trackingNumber).toBe("TRACK2");
  });
});

describe("sweepReviewRequestTriggers", () => {
  it("sends the review check-in and marks reviewRequested true", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" }).mockResolvedValueOnce({ providerMessageId: "msg_review" });

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK999");
    await backdateTrigger(personId);

    const result = await sweepReviewRequestTriggers();
    expect(result.sentCount).toBeGreaterThanOrEqual(1);

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.reviewRequested).toBe(true);
  });

  it("cancels a due trigger for a do-not-disturb customer instead of sending", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" }); // handleOrderShipped's own notice

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK-DND");
    await backdateTrigger(personId);
    await setCustomerSmsDnd(personId, true);

    sendMessageMock.mockClear();
    const result = await sweepReviewRequestTriggers();
    expect(result.cancelledCount).toBeGreaterThanOrEqual(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("opted_out");
  });

  it("sends exactly once when a second sweep starts while the first is still mid-send for the same trigger", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" }); // handleOrderShipped's own notice
    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK-RACE");
    await backdateTrigger(personId);

    // Delay only the first review-request send so a second, overlapping sweep
    // call has a real window to start (and, on the old select-then-update-at-
    // the-end code, re-claim the same still-"pending" trigger) before the
    // first finishes.
    let callCount = 0;
    sendMessageMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          callCount += 1;
          const providerMessageId = callCount === 1 ? "msg_first" : "msg_second";
          setTimeout(() => resolve({ providerMessageId }), callCount === 1 ? 60 : 0);
        }),
    );

    const first = sweepReviewRequestTriggers();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the first sweep's claim UPDATE land before the second starts
    const second = sweepReviewRequestTriggers();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.sentCount + r2.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(2); // handleOrderShipped's notice + exactly one review-request send
    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
  });

  it("marks failed with NO_PHONE_NUMBER and does not call the provider when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    // No mockResolvedValueOnce here: handleOrderShipped never calls
    // sendMessage when the customer has no phone, so a queued once-value
    // would go unconsumed here and silently leak into the next test's mock
    // queue (mockClear() doesn't purge queued once-implementations) —
    // that's exactly what was happening before this comment was added.

    const personId = await seedCustomer({ phone: null });
    await handleOrderShipped(personId, "TRACK1");
    await backdateTrigger(personId);

    sendMessageMock.mockClear();
    const result = await sweepReviewRequestTriggers();
    expect(result.failedCount).toBeGreaterThanOrEqual(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("failed");
    expect(trigger.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("does not mark reviewRequested true when the send itself fails", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" }); // handleOrderShipped's own notice
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_PROVIDER_TIMEOUT"));

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK-FAIL");
    await backdateTrigger(personId);

    await sweepReviewRequestTriggers();

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("failed");
    expect(trigger.attemptCount).toBe(1);

    // Must NOT be true — the patient never actually received the review
    // check-in message, so Sarah's next reply must not be parsed as a
    // sentiment answer to a question that was never sent.
    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.reviewRequested).toBe(false);
  });

  it("retries a failed trigger once it cools down, and succeeds on the retry", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" }); // handleOrderShipped's own notice
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_PROVIDER_TIMEOUT"));

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK-RETRY");
    await backdateTrigger(personId);

    const first = await sweepReviewRequestTriggers();
    expect(first.failedCount).toBe(1);

    // Still within the cooldown window — must not be retried yet.
    sendMessageMock.mockClear();
    const tooSoon = await sweepReviewRequestTriggers();
    expect(tooSoon.sentCount).toBe(0);
    expect(tooSoon.failedCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();

    // Simulate the cooldown having elapsed.
    await db.update(reviewRequestTriggersTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(reviewRequestTriggersTable.personId, personId));

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_retry_success" });
    const retry = await sweepReviewRequestTriggers();
    expect(retry.sentCount).toBe(1);

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
    expect(trigger.attemptCount).toBe(2);
    expect(trigger.providerMessageId).toBe("msg_retry_success");

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.reviewRequested).toBe(true);
  });

  it("stops retrying once the attempt cap is reached, leaving it permanently failed", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped" }); // handleOrderShipped's own notice

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK-EXHAUST");
    await backdateTrigger(personId);

    // Directly set the trigger to "failed" at the attempt cap, cooled down —
    // simulating it having already exhausted every retry.
    await db
      .update(reviewRequestTriggersTable)
      .set({ status: "failed", failureReason: "SMS_PROVIDER_TIMEOUT", attemptCount: 3, updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(reviewRequestTriggersTable.personId, personId));

    sendMessageMock.mockClear();
    const result = await sweepReviewRequestTriggers();
    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("failed");
    expect(trigger.attemptCount).toBe(3);
  });

  it("leaves not-yet-due triggers untouched", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped_future" });

    const personId = await seedCustomer();
    await handleOrderShipped(personId, "TRACK-FUTURE");

    sendMessageMock.mockClear();
    await sweepReviewRequestTriggers();
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
  });
});
