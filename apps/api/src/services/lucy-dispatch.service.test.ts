import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, conversationsTable } from "@luma/db";
import type { LucyTurnResult } from "./lucy-conversation.service.js";
import { isCustomerSmsDnd, setCustomerSmsDnd, setCustomerEmailDnd } from "./dnd.service.js";

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
    preCheckCode: null,
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

  it("serializes two double-texted inbound messages instead of racing them", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_race" });

    const seenHistoryLengths: number[] = [];
    runLucyTurnMock.mockImplementation(async (_personId: string, body: { messages: readonly unknown[] }) => {
      // Snapshot synchronously at call time — before any delay — so this
      // reflects exactly what conversation history was visible the instant
      // Claude was invoked for this turn.
      seenHistoryLengths.push(body.messages.length);
      const isFirstCall = seenHistoryLengths.length === 1;
      if (isFirstCall) {
        // Force real overlap: the second processInboundMessage call starts
        // while this first one is still mid-turn.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return okResult({ reply: isFirstCall ? "First reply." : "Second reply.", nextQuestion: null });
    });

    const personId = await seedCustomer();
    const [r1, r2] = await Promise.all([processInboundMessage(personId, "first text"), processInboundMessage(personId, "second text")]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Without serialization, the second call's Claude turn would start
    // immediately and only see its own inbound message (history length 1) —
    // blind to the first text entirely, let alone the first turn's reply.
    // With the lock, the second call only starts once the first has fully
    // persisted both its inbound message and its outbound reply, so it sees
    // both of those plus its own inbound message.
    expect(seenHistoryLengths).toEqual([1, 3]);

    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.map((m) => ({ direction: m.direction, body: m.body }))).toEqual([
      { direction: "inbound", body: "first text" },
      { direction: "outbound", body: "First reply." },
      { direction: "inbound", body: "second text" },
      { direction: "outbound", body: "Second reply." },
    ]);
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

  it("sends the OPT_OUT confirmation reply, then marks the customer DND — the confirmation itself is not blocked", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_optout" });
    runLucyTurnMock.mockResolvedValueOnce(
      okResult({
        action: "pause",
        reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help.",
        nextQuestion: null,
        requiresStaff: false,
        source: "pre_check_block",
        preCheckCode: "OPT_OUT",
      }),
    );

    const personId = await seedCustomer();
    expect(await isCustomerSmsDnd(personId)).toBe(false);

    await processInboundMessage(personId, "STOP");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15551230000", "You've been unsubscribed and won't receive further messages. Reply HELP for help.");
    expect(await isCustomerSmsDnd(personId)).toBe(true);
  });

  it("does not send anything to a customer who is already do-not-disturb", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    runLucyTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);

    await processInboundMessage(personId, "how much is tirzepatide?");

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still sends SMS when the customer is only email do-not-disturb — the two channels are independent", async () => {
    runLucyTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_email_dnd_only" });
    runLucyTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));

    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    await processInboundMessage(personId, "how much is tirzepatide?");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
