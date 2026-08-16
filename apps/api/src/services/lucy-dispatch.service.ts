import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runLucyTurn, type LucyTurnResult } from "./lucy-conversation.service.js";
import {
  getOrCreateConversation,
  listMessages,
  appendMessage,
  setMessageSentiment,
  updateConversationState,
  toBotPreviewBody,
  type ConversationStatePatch,
} from "./conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

/**
 * Sends a text through the SMS provider and logs it in the conversation
 * regardless of whether the send succeeds — a send failure (most likely: no
 * provider configured yet) doesn't erase the fact that this is what Lucy's
 * guardrail-approved reply actually was. Failures are logged, not thrown;
 * this function never blocks the caller on a transport problem.
 */
async function sendAndLog(conversationId: string, phone: string | null, text: string): Promise<void> {
  let providerMessageId: string | null = null;
  if (phone) {
    try {
      const result = await getSmsProvider().sendMessage(phone, text);
      providerMessageId = result.providerMessageId;
    } catch (err) {
      logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Lucy message send failed");
    }
  } else {
    logger.warn({ conversationId }, "outbound Lucy message not sent: no phone number on file");
  }
  await appendMessage(conversationId, "outbound", text, { providerMessageId });
}

/**
 * Full inbound-turn pipeline: persist the inbound message, run it through
 * the guardrail loop, tag its sentiment, send (and log) whatever Lucy's
 * validated reply is, and persist the updated conversation state. This is
 * the real dispatch path — it calls the SMS provider for real, same as the
 * follow-up pipeline, and fails the same way (cleanly, loudly, not silently)
 * until a provider is actually configured.
 */
export async function processInboundMessage(personId: string, inboundBody: string): Promise<LucyTurnResult> {
  const conversation = await getOrCreateConversation(personId);
  const priorMessages = await listMessages(conversation.id);
  const inboundMessage = await appendMessage(conversation.id, "inbound", inboundBody);

  const body = toBotPreviewBody(conversation, [...priorMessages, inboundMessage]);
  const result = await runLucyTurn(personId, body);

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Lucy turn rejected — no outbound message sent");
    // The customer got silence, not just a routed reply — that's exactly the
    // kind of thing a human should see, not just a log line.
    await updateConversationState(conversation.id, { needsAttention: true });
    return result;
  }

  await setMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);
  const textsToSend = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t));
  for (const text of textsToSend) {
    await sendAndLog(conversation.id, customer?.phone ?? null, text);
  }

  const slotPatch: ConversationStatePatch = {};
  for (const [key, value] of Object.entries(result.validatedSlotUpdates)) {
    (slotPatch as Record<string, unknown>)[key] = value;
  }

  await updateConversationState(conversation.id, {
    ...slotPatch,
    lastQuestion: result.nextQuestion,
    lastDraft: result.reply,
    objectionStage: result.objectionStage,
    linkProvided: result.linkProvided,
    promoOffered: result.promoOffered,
    ...(result.requiresStaff ? { needsAttention: true } : {}),
  });

  return result;
}
