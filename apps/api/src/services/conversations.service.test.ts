import { describe, expect, it } from "vitest";
import { db, customersTable } from "@luma/db";
import {
  getOrCreateConversation,
  appendMessage,
  setMessageSentiment,
  listMessages,
  updateConversationState,
  toBotPreviewBody,
  listConversationSummaries,
  getConversationDetail,
} from "./conversations.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Convo", lastName: "Test", email: `convo-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("getOrCreateConversation", () => {
  it("creates a conversation with default state on first call", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    expect(conversation.personId).toBe(personId);
    expect(conversation.status).toBe("active");
    expect(conversation.objectionStage).toBe(0);
    expect(conversation.linkProvided).toBe(false);
    expect(conversation.promoOffered).toBe(false);
  });

  it("returns the same conversation on subsequent calls (1:1 per customer)", async () => {
    const personId = await seedCustomer();
    const first = await getOrCreateConversation(personId);
    const second = await getOrCreateConversation(personId);
    expect(second.id).toBe(first.id);
  });
});

describe("appendMessage / listMessages", () => {
  it("appends messages in order and returns them oldest-first", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "inbound", "Hi there");
    await appendMessage(conversation.id, "outbound", "Hey! How can I help?");
    await appendMessage(conversation.id, "inbound", "How much is semaglutide?");

    const messages = await listMessages(conversation.id);
    expect(messages.map((m) => m.body)).toEqual(["Hi there", "Hey! How can I help?", "How much is semaglutide?"]);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound"]);
  });

  it("caps history to the requested limit, keeping the most recent", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    for (let i = 0; i < 5; i++) {
      await appendMessage(conversation.id, i % 2 === 0 ? "inbound" : "outbound", `message ${i}`);
    }
    const messages = await listMessages(conversation.id, 2);
    expect(messages.map((m) => m.body)).toEqual(["message 3", "message 4"]);
  });

  it("stores sentiment and providerMessageId when provided", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const msg = await appendMessage(conversation.id, "inbound", "This is way too expensive", { sentiment: "negative" });
    expect(msg.sentiment).toBe("negative");

    const outbound = await appendMessage(conversation.id, "outbound", "Understood", { providerMessageId: "msg_abc" });
    expect(outbound.providerMessageId).toBe("msg_abc");
  });
});

describe("setMessageSentiment", () => {
  it("updates an existing message's sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const msg = await appendMessage(conversation.id, "inbound", "Sounds great, let's go!");
    await setMessageSentiment(msg.id, "positive");

    const [messages] = [await listMessages(conversation.id)];
    expect(messages[0].sentiment).toBe("positive");
  });

  it("is a no-op when sentiment is null", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const msg = await appendMessage(conversation.id, "inbound", "hmm", { sentiment: "neutral" });
    await setMessageSentiment(msg.id, null);

    const messages = await listMessages(conversation.id);
    expect(messages[0].sentiment).toBe("neutral");
  });
});

describe("updateConversationState", () => {
  it("only patches the given fields, leaving the rest untouched", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, { selectedProduct: "semaglutide", objectionStage: 1 });

    const [updated] = [await getOrCreateConversation(personId)];
    expect(updated.selectedProduct).toBe("semaglutide");
    expect(updated.objectionStage).toBe(1);
    expect(updated.linkProvided).toBe(false);
    expect(updated.promoOffered).toBe(false);
  });
});

describe("toBotPreviewBody", () => {
  it("maps conversation state and history into the shape runLucyTurn expects", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, {
      selectedProduct: "tirzepatide",
      lastQuestion: "Want to see pricing?",
      objectionStage: 2,
      linkProvided: true,
      promoOffered: true,
    });
    const updated = await getOrCreateConversation(personId);
    const messages = await appendMessage(conversation.id, "inbound", "yes please").then(() => listMessages(conversation.id));

    const body = toBotPreviewBody(updated, messages);
    expect(body.currentSlots.selectedProduct).toBe("tirzepatide");
    expect(body.lastQuestion).toBe("Want to see pricing?");
    expect(body.objectionStage).toBe(2);
    expect(body.linkProvided).toBe(true);
    expect(body.promoOffered).toBe(true);
    expect(body.messages).toEqual([{ direction: "inbound", body: "yes please" }]);
  });
});

describe("listConversationSummaries / getConversationDetail", () => {
  it("includes the customer's name, last message preview, and last inbound sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "inbound", "first message", { sentiment: "neutral" });
    await appendMessage(conversation.id, "outbound", "a reply");
    await appendMessage(conversation.id, "inbound", "second message, more excited!", { sentiment: "positive" });

    const summaries = await listConversationSummaries();
    const summary = summaries.find((s) => s.personId === personId);
    expect(summary).toBeDefined();
    expect(summary?.firstName).toBe("Convo");
    expect(summary?.lastMessagePreview).toBe("second message, more excited!");
    expect(summary?.lastSentiment).toBe("positive");

    const detail = await getConversationDetail(conversation.id);
    expect(detail?.messages.length).toBe(3);
  });

  it("getConversationDetail returns null for an unknown conversation id", async () => {
    const detail = await getConversationDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });
});
