import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runSarahTurn, type SarahTurnResult } from "./sarah-conversation.service.js";
import {
  getOrCreateSupportConversation,
  listSupportMessages,
  appendSupportMessage,
  setSupportMessageSentiment,
  updateSupportConversationState,
  toSarahPreviewBody,
  type SupportConversationStatePatch,
} from "./support-conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

/** Same fail-soft send+log pattern as Lucy's dispatch (lucy-dispatch.service.ts's sendAndLog). */
async function sendAndLog(conversationId: string, phone: string | null, text: string): Promise<void> {
  let providerMessageId: string | null = null;
  if (phone) {
    try {
      const result = await getSmsProvider().sendMessage(phone, text);
      providerMessageId = result.providerMessageId;
    } catch (err) {
      logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Sarah message send failed");
    }
  } else {
    logger.warn({ conversationId }, "outbound Sarah message not sent: no phone number on file");
  }
  await appendSupportMessage(conversationId, "outbound", text, { providerMessageId });
}

/**
 * Full inbound-turn pipeline for Sarah, mirroring processInboundMessage in
 * lucy-dispatch.service.ts: persist the inbound message, run the guardrail
 * loop, tag sentiment, send+log the validated reply, persist updated state.
 */
export async function processInboundSupportMessage(personId: string, inboundBody: string): Promise<SarahTurnResult> {
  const conversation = await getOrCreateSupportConversation(personId);
  const priorMessages = await listSupportMessages(conversation.id);
  const inboundMessage = await appendSupportMessage(conversation.id, "inbound", inboundBody);

  const body = toSarahPreviewBody(conversation, [...priorMessages, inboundMessage]);
  const result = await runSarahTurn(body);

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Sarah turn rejected — no outbound message sent");
    await updateSupportConversationState(conversation.id, { needsAttention: true });
    return result;
  }

  await setSupportMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);
  const textsToSend = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t));
  for (const text of textsToSend) {
    await sendAndLog(conversation.id, customer?.phone ?? null, text);
  }

  const statePatch: SupportConversationStatePatch = {
    lastQuestion: result.nextQuestion,
    lastDraft: result.reply,
    ...(result.requiresStaff ? { needsAttention: true } : {}),
    ...(conversation.reviewRequested && result.inboundSentiment !== null ? { reviewSentiment: result.inboundSentiment } : {}),
  };
  await updateSupportConversationState(conversation.id, statePatch);

  return result;
}
