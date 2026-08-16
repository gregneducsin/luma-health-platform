import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, conversationsTable } from "@luma/db";
import type { LucyTurnResult } from "./lucy-conversation.service.js";

const runLucyTurnMock = vi.fn();
vi.mock("./lucy-conversation.service.js", async () => {
  const actual = await vi.importActual<typeof import("./lucy-conversation.service.js")>("./lucy-conversation.service.js");
  return { ...actual, runLucyTurn: (...args: unknown[]) => runLucyTurnMock(...args) };
});

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { processInboundMessage } = await import("./lucy-dispatch.service.js");
const { getOrCreateConversation, listMessages } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Dispatch",
      lastName: "Test",
      email: `dispatch-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15551230000" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

function okResult(overrides: Partial<Extract<LucyTurnResult, { ok: true }>> = {}): LucyTurnResult {
  return {
    ok: true,
    action: "reply",
    reply: "Semaglutide starts at $120 for the 1-month plan.",
    nextQuestion: "Which plan are you considering?",
    link: null,
    objectionStage: 0,
    linkProvided: false,
    promoOffered: false,
    inboundSentiment: "neutral",
    requiresStaff: false,
    knowledgeTopicsUsed: ["semaglutide_pricing"],
    validatedSlotUpdates: {},
    source: "model",
    ...overrides,
  };
}

describe("processInboundMessage", () => {
  it("persists the inbound message, tags its sentiment, and sends+logs both reply and nextQuestion", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_1" }).mockResolvedValueOnce({ providerMessageId: "msg_2" });
    runLucyTurnMock.mockResolvedValueOnce(okResult({ inboundSentiment: "positive" }));

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "How much is semaglutide?");

    expect(result.ok).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "+15551230000", "Semaglutide starts at $120 for the 1-month plan.");
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "+15551230000", "Which plan are you considering?");

    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.map((m) => ({ direction: m.direction, body: m.body }))).toEqual([
      { direction: "inbound", body: "How much is semaglutide?" },
      { direction: "outbound", body: "Semaglutide starts at $120 for the 1-month plan." },
      { direction: "outbound", body: "Which plan are you considering?" },
    ]);
    expect(messages[0].sentiment).toBe("positive");
    expect(messages[1].providerMessageId).toBe("msg_1");
    expect(messages[2].providerMessageId).toBe("msg_2");
  });

  it("merges validatedSlotUpdates into conversation state and stores objectionStage/linkProvided/promoOffered", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_x" });
    runLucyTurnMock.mockResolvedValueOnce(
      okResult({ objectionStage: 1, linkProvided: true, promoOffered: true, validatedSlotUpdates: { selectedProduct: "tirzepatide" } }),
    );

    const personId = await seedCustomer();
    await processInboundMessage(personId, "I'm interested in tirzepatide");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.selectedProduct).toBe("tirzepatide");
    expect(conversation.objectionStage).toBe(1);
    expect(conversation.linkProvided).toBe(true);
    expect(conversation.promoOffered).toBe(true);
    expect(conversation.lastQuestion).toBe("Which plan are you considering?");
  });

  it("still logs the outbound message when the SMS send itself fails, but without a providerMessageId", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("No SMS provider is configured (SMS_PROVIDER is unset)."));
    runLucyTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "tell me more");

    expect(result.ok).toBe(true);
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound?.providerMessageId).toBeNull();
  });

  it("does not send anything, but still persists the inbound message, when the customer has no phone on file", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    runLucyTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer({ phone: null });
    await processInboundMessage(personId, "hello");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.some((m) => m.direction === "inbound" && m.body === "hello")).toBe(true);
  });

  it("does not send or persist any outbound message when the guardrail rejects the turn, but flags the conversation for staff attention", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    runLucyTurnMock.mockResolvedValueOnce({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "give me a discount");

    expect(result.ok).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("inbound");
    expect(conversation.needsAttention).toBe(true);
  });

  it("flags the conversation for staff attention when the model itself flags requiresStaff (e.g. action=staff_review)", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    runLucyTurnMock.mockResolvedValueOnce(
      okResult({ action: "staff_review", reply: null, nextQuestion: null, requiresStaff: true, source: "pre_check_block" }),
    );

    const personId = await seedCustomer();
    await processInboundMessage(personId, "I need to speak to a lawyer");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.needsAttention).toBe(true);
  });

  it("does not flag the conversation when the turn is a normal, non-staff reply", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_ok" });
    runLucyTurnMock.mockResolvedValueOnce(okResult({ requiresStaff: false }));

    const personId = await seedCustomer();
    await processInboundMessage(personId, "how much is semaglutide?");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.needsAttention).toBe(false);
  });

  it("does not create a duplicate conversation across multiple inbound turns", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_y" });
    runLucyTurnMock.mockResolvedValue(okResult());

    const personId = await seedCustomer();
    await processInboundMessage(personId, "first");
    await processInboundMessage(personId, "second");

    const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
    expect(rows.length).toBe(1);
  });
});
