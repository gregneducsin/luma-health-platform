import { describe, expect, it, vi } from "vitest";
import { db, customersTable } from "@luma/db";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { sendMetaLeadOpener } = await import("./meta-lead.service.js");
const { getOrCreateConversation, listMessages } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null; firstName?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: opts.firstName ?? "Meta",
      lastName: "Test",
      email: `meta-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15558880000" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("sendMetaLeadOpener", () => {
  it("sends the opener, logs it in a meta_form conversation", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_meta_opener" });

    const personId = await seedCustomer({ firstName: "Jamie" });
    await sendMetaLeadOpener(personId);

    expect(sendMessageMock).toHaveBeenCalledWith("+15558880000", expect.stringContaining("what state you're in"));

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.leadSource).toBe("meta_form");
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].providerMessageId).toBe("msg_meta_opener");
    expect(messages[0].body).toContain("Jamie");
  });

  it("does not call the provider and does not log anything when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });

    await sendMetaLeadOpener(personId);

    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(0);
  });

  it("still logs the would-be message when the SMS send itself throws", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_DOWN"));

    const personId = await seedCustomer();
    await sendMetaLeadOpener(personId);

    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].providerMessageId).toBeNull();
  });
});
