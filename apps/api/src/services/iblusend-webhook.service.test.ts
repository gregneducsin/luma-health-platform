import { describe, expect, it, vi } from "vitest";
import { db, customersTable, conversationsTable, supportConversationsTable, webhookEventsTable } from "@luma/db";
import { eq } from "drizzle-orm";

const processInboundMessageMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("./lucy-dispatch.service.js", () => ({ processInboundMessage: processInboundMessageMock }));

const processInboundSupportMessageMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("./sarah-dispatch.service.js", () => ({ processInboundSupportMessage: processInboundSupportMessageMock }));

const { handleIbluSendWebhook } = await import("./iblusend-webhook.service.js");

// A fresh, collision-free phone number per call — the suite has other test
// files seeding customers with hardcoded phone numbers, and a shared
// (non-schema-isolated) DATABASE_URL across files means a hardcoded number
// here could match an unrelated customer from another file's test, causing
// findCustomerIdByPhone to silently resolve to the wrong row.
function uniquePhone(): string {
  return "+1555" + crypto.randomUUID().replace(/-/g, "").slice(0, 7);
}

async function seedCustomer(phone: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "iBluSend",
      lastName: "Test",
      email: `iblusend-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-17",
      phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

function envelope(overrides: { event?: string; eventId?: string; data?: Record<string, unknown> } = {}) {
  return {
    event: overrides.event ?? "message.received",
    event_id: overrides.eventId ?? crypto.randomUUID(),
    timestamp: "2026-08-17T12:00:00.000Z",
    api_version: "2026-03-07",
    data: {
      message_id: crypto.randomUUID(),
      phone_number: uniquePhone(),
      content: "hello",
      direction: "incoming",
      service_type: "iMessage",
      ...overrides.data,
    },
  };
}

describe("handleIbluSendWebhook", () => {
  it("routes to Sarah when a support conversation already exists for the customer", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(supportConversationsTable).values({ personId });

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "when should I take this" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundSupportMessageMock).toHaveBeenCalledWith(personId, "when should I take this");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("routes to Lucy when only a Lucy conversation exists, no support conversation", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "how much is it" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).toHaveBeenCalledWith(personId, "how much is it");
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("prefers Sarah over Lucy when both conversations exist", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });
    await db.insert(supportConversationsTable).values({ personId });

    await handleIbluSendWebhook(envelope({ data: { phone_number: phone } }));

    expect(processInboundSupportMessageMock).toHaveBeenCalled();
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("does not dispatch to either bot for an unrecognized phone number", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: uniquePhone() } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("does not dispatch for a person with neither a Lucy nor a Sarah conversation", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    await seedCustomer(phone);
    await handleIbluSendWebhook(envelope({ data: { phone_number: phone } }));

    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("ignores outbound-direction messages", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });

    await handleIbluSendWebhook(envelope({ data: { phone_number: phone, direction: "outgoing" } }));

    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("acknowledges and no-ops for an event type it doesn't act on", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const result = await handleIbluSendWebhook(envelope({ event: "message.delivered", data: { status: "delivered" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("dedupes on event_id — a second delivery of the same occurrence is reported as duplicate and not re-dispatched", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });

    const eventId = crypto.randomUUID();
    const first = await handleIbluSendWebhook(envelope({ eventId, data: { phone_number: phone } }));
    const second = await handleIbluSendWebhook(envelope({ eventId, data: { phone_number: phone } }));

    expect(first).toEqual({ duplicate: false });
    expect(second).toEqual({ duplicate: true });
    expect(processInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("records the webhook event with source iblusend_message", async () => {
    const eventId = crypto.randomUUID();
    await handleIbluSendWebhook(envelope({ eventId, data: { phone_number: uniquePhone() } }));

    const [row] = await db.select().from(webhookEventsTable).where(eq(webhookEventsTable.externalEventId, eventId));
    expect(row?.source).toBe("iblusend_message");
    expect(row?.status).toBe("processed");
  });
});
