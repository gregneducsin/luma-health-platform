import { describe, expect, it } from "vitest";
import { db, customersTable } from "@luma/db";
import {
  getOrCreateSupportConversation,
  appendSupportMessage,
  setSupportMessageSentiment,
  listSupportMessages,
  updateSupportConversationState,
  toSarahPreviewBody,
  listSupportConversationSummaries,
  getSupportConversationDetail,
} from "./support-conversations.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Support", lastName: "Test", email: `support-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-16" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("getOrCreateSupportConversation", () => {
  it("creates a conversation with default state on first call", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.personId).toBe(personId);
    expect(conversation.status).toBe("active");
    expect(conversation.prescriptionWritten).toBe(false);
    expect(conversation.orderShipped).toBe(false);
    expect(conversation.trackingNumber).toBeNull();
    expect(conversation.reviewRequested).toBe(false);
  });

  it("returns the same conversation on subsequent calls (1:1 per customer)", async () => {
    const personId = await seedCustomer();
    const first = await getOrCreateSupportConversation(personId);
    const second = await getOrCreateSupportConversation(personId);
    expect(second.id).toBe(first.id);
  });
});

describe("appendSupportMessage / listSupportMessages", () => {
  it("appends messages in order and returns them oldest-first", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Hello, this is Sarah.");
    await appendSupportMessage(conversation.id, "inbound", "Has my order shipped?");

    const messages = await listSupportMessages(conversation.id);
    expect(messages.map((m) => m.body)).toEqual(["Hello, this is Sarah.", "Has my order shipped?"]);
    expect(messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
  });
});

describe("setSupportMessageSentiment", () => {
  it("updates an existing message's sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const msg = await appendSupportMessage(conversation.id, "inbound", "This has been great!");
    await setSupportMessageSentiment(msg.id, "positive");

    const messages = await listSupportMessages(conversation.id);
    expect(messages[0].sentiment).toBe("positive");
  });

  it("is a no-op when sentiment is null", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const msg = await appendSupportMessage(conversation.id, "inbound", "hmm", { sentiment: "neutral" });
    await setSupportMessageSentiment(msg.id, null);

    const messages = await listSupportMessages(conversation.id);
    expect(messages[0].sentiment).toBe("neutral");
  });
});

describe("updateSupportConversationState", () => {
  it("only patches the given fields, leaving the rest untouched", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await updateSupportConversationState(conversation.id, { prescriptionWritten: true, trackingNumber: "TRACK123" });

    const updated = await getOrCreateSupportConversation(personId);
    expect(updated.prescriptionWritten).toBe(true);
    expect(updated.trackingNumber).toBe("TRACK123");
    expect(updated.orderShipped).toBe(false);
  });
});

describe("toSarahPreviewBody", () => {
  it("maps conversation order state and history into the shape runSarahTurn expects", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await updateSupportConversationState(conversation.id, {
      prescriptionWritten: true,
      orderShipped: true,
      trackingNumber: "TRACK999",
      reviewRequested: true,
      lastQuestion: "Anything else?",
    });
    const updated = await getOrCreateSupportConversation(personId);
    const messages = await appendSupportMessage(conversation.id, "inbound", "thanks!").then(() => listSupportMessages(conversation.id));

    const body = toSarahPreviewBody(updated, messages);
    expect(body.orderState).toEqual({ prescriptionWritten: true, orderShipped: true, trackingNumber: "TRACK999" });
    expect(body.reviewRequested).toBe(true);
    expect(body.lastQuestion).toBe("Anything else?");
    expect(body.messages).toEqual([{ direction: "inbound", body: "thanks!" }]);
  });
});

describe("listSupportConversationSummaries / getSupportConversationDetail", () => {
  it("includes the customer's name, last message preview, and last inbound sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Hello");
    await appendSupportMessage(conversation.id, "inbound", "All good, thanks!", { sentiment: "positive" });

    const summaries = await listSupportConversationSummaries();
    const summary = summaries.find((s) => s.personId === personId);
    expect(summary).toBeDefined();
    expect(summary?.firstName).toBe("Support");
    expect(summary?.lastMessagePreview).toBe("All good, thanks!");
    expect(summary?.lastSentiment).toBe("positive");

    const detail = await getSupportConversationDetail(conversation.id);
    expect(detail?.messages.length).toBe(2);
  });

  it("getSupportConversationDetail returns null for an unknown conversation id", async () => {
    const detail = await getSupportConversationDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });
});
