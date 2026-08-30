import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable, leadCheckinTriggersTable, consumerAffairsTriggersTable } from "@luma/db";
import { setCustomerSmsDnd } from "./dnd.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { scheduleConsumerAffairsOpener, sweepConsumerAffairsTriggers } = await import("./consumer-affairs.service.js");
const { getOrCreateConversation, listMessages } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null; firstName?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: opts.firstName ?? "Affairs",
      lastName: "Test",
      email: `consumer-affairs-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15556660000" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function backdateTrigger(personId: string) {
  await db.update(consumerAffairsTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(consumerAffairsTriggersTable.personId, personId));
}

describe("scheduleConsumerAffairsOpener", () => {
  it("schedules a pending trigger due about 10 minutes out", async () => {
    const personId = await seedCustomer();
    await scheduleConsumerAffairsOpener(personId);

    const [trigger] = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
    const dueInMs = new Date(trigger.dueAt).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(10 * 60 * 1000 - 10_000);
    expect(dueInMs).toBeLessThan(10 * 60 * 1000 + 10_000);
  });

  it("is idempotent per person — a duplicate call does not create a second trigger", async () => {
    const personId = await seedCustomer();
    await scheduleConsumerAffairsOpener(personId);
    await scheduleConsumerAffairsOpener(personId);

    const triggers = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(triggers.length).toBe(1);
  });
});

describe("sweepConsumerAffairsTriggers", () => {
  it("sends the opener naming Consumer Affairs, introduces Lucy, and arms the 6-day check-in", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ca_opener" });

    const personId = await seedCustomer({ firstName: "Jordan" });
    await scheduleConsumerAffairsOpener(personId);
    await backdateTrigger(personId);

    const result = await sweepConsumerAffairsTriggers();
    expect(result.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15556660000", expect.stringContaining("Consumer Affairs"));
    expect(sendMessageMock).toHaveBeenCalledWith("+15556660000", expect.stringContaining("this is Lucy with Luma Health"));

    const [trigger] = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");

    const [checkin] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(checkin?.status).toBe("pending");

    const messages = await listMessages((await getOrCreateConversation(personId)).id);
    expect(messages[0].body).toContain("Jordan");
  });

  it("drops the self-introduction when the person already has an active conversation", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ca_followup" });

    const personId = await seedCustomer();
    await getOrCreateConversation(personId); // an existing conversation, as if they also came in as a Meta lead first
    await scheduleConsumerAffairsOpener(personId);
    await backdateTrigger(personId);

    await sweepConsumerAffairsTriggers();

    expect(sendMessageMock).toHaveBeenCalledWith("+15556660000", expect.stringContaining("Consumer Affairs"));
    const [call] = sendMessageMock.mock.calls;
    expect(call[1]).not.toContain("this is Lucy with Luma Health");
  });

  it("cancels when the person already purchased by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleConsumerAffairsOpener(personId);
    await backdateTrigger(personId);

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    const result = await sweepConsumerAffairsTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("already_purchased");
  });

  it("cancels when the person is do-not-disturb by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleConsumerAffairsOpener(personId);
    await backdateTrigger(personId);
    await setCustomerSmsDnd(personId, true);

    const result = await sweepConsumerAffairsTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("opted_out");
  });

  it("marks failed with NO_PHONE_NUMBER and does not call the provider when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    await scheduleConsumerAffairsOpener(personId);
    await backdateTrigger(personId);

    const result = await sweepConsumerAffairsTriggers();
    expect(result.failedCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(trigger.status).toBe("failed");
    expect(trigger.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("leaves not-yet-due triggers untouched", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleConsumerAffairsOpener(personId);

    const result = await sweepConsumerAffairsTriggers();
    expect(result.sentCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(consumerAffairsTriggersTable).where(eq(consumerAffairsTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
  });
});
