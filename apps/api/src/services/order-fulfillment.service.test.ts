import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, reviewRequestTriggersTable } from "@luma/db";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
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

  it("does not call the provider when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    await sendOrderReceivedOpener(personId);
    expect(sendMessageMock).not.toHaveBeenCalled();
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
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_shipped_no_phone" });

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
