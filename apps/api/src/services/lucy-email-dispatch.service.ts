import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runLucyTurn, type LucyTurnResult } from "./lucy-conversation.service.js";
import {
  getOrCreateEmailConversation,
  listEmailMessages,
  appendEmailMessage,
  setEmailMessageSentiment,
  updateEmailConversationState,
  toEmailPreviewBody,
  type EmailConversationStatePatch,
} from "./email-conversations.service.js";
import { getEmailProvider } from "../lib/email-provider.js";
import { renderConversationReplyEmail } from "../lib/email/templates.js";
import { buildUnsubscribeUrl } from "../lib/email/unsubscribe.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerEmailDnd, setCustomerEmailDnd } from "./dnd.service.js";

async function getCustomerContact(personId: string): Promise<{ firstName: string; email: string } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, email: customersTable.email }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

function replySubject(originalSubject: string): string {
  return /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
}

const SIGN_OFF = "Lucy at Luma Health";

/** Unlike a text, an email reads as unfinished without a greeting and a sign-off — Claude drafts only the substantive reply body (same as it does for SMS), so this wraps it, not the model. */
function withGreetingAndSignOff(firstName: string, bodyText: string): string {
  const greeting = firstName.trim() ? `Hi ${firstName.trim()},` : "Hi,";
  return `${greeting}\n\n${bodyText}\n\n— ${SIGN_OFF}`;
}

/**
 * Sends a threaded reply email and logs it in the email conversation
 * regardless of whether the send succeeds — same fail-soft reasoning as
 * lucy-dispatch.service.ts's sendAndLog. DND is checked here, not earlier
 * in the pipeline, for the identical reason documented there: an OPT_OUT
 * confirmation reply must still go out before the flag it's about to set
 * would otherwise block it.
 */
async function sendAndLog(
  personId: string,
  conversationId: string,
  email: string,
  firstName: string,
  subject: string,
  bodyText: string,
  inReplyTo: string | null,
): Promise<void> {
  if (await isCustomerEmailDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Lucy email not sent: customer is do-not-disturb");
    return;
  }

  const signedBody = withGreetingAndSignOff(firstName, bodyText);
  let messageId: string | null = null;
  try {
    const { provider, fromName } = getEmailProvider("lucy");
    const unsubscribeUrl = buildUnsubscribeUrl(personId);
    const html = renderConversationReplyEmail(signedBody, unsubscribeUrl);
    const result = await provider.sendEmail(email, subject, html, {
      fromName,
      inReplyTo: inReplyTo ?? undefined,
      references: inReplyTo ?? undefined,
      unsubscribeUrl,
    });
    messageId = result.messageId;
  } catch (err) {
    logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Lucy email send failed");
  }
  await appendEmailMessage(conversationId, "outbound", subject, signedBody, { messageId, inReplyTo });
}

/**
 * Email twin of lucy-dispatch.service.ts's processInboundMessage — same
 * guardrail pipeline (runLucyTurn, unchanged), same withPersonLock
 * serialization reasoning, its own email conversation table. The one real
 * adaptation for the channel: SMS sends reply and nextQuestion as two
 * separate texts; email combines them into one message body, since a
 * two-email reply to a single inbound email reads as broken, not as two
 * conversational beats the way two quick texts do.
 */
export async function processInboundEmail(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<LucyTurnResult> {
  return withPersonLock(personId, () => processInboundEmailLocked(personId, subject, bodyText, messageId));
}

async function processInboundEmailLocked(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<LucyTurnResult> {
  const conversation = await getOrCreateEmailConversation(personId);
  const priorMessages = await listEmailMessages(conversation.id);
  const inboundMessage = await appendEmailMessage(conversation.id, "inbound", subject, bodyText, { messageId });

  const body = toEmailPreviewBody(conversation, [...priorMessages, inboundMessage]);
  const result = await runLucyTurn(personId, body);

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Lucy email turn rejected — no outbound email sent");
    await updateEmailConversationState(conversation.id, { needsAttention: true });
    return result;
  }

  await setEmailMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);
  const combinedBody = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t)).join("\n\n");
  if (combinedBody && customer) {
    await sendAndLog(personId, conversation.id, customer.email, customer.firstName, replySubject(subject), combinedBody, inboundMessage.messageId);
  }

  // Set DND only after this turn's reply has gone out — see sendAndLog's docstring.
  if (result.preCheckCode === "OPT_OUT") {
    await setCustomerEmailDnd(personId, true);
  }

  const slotPatch: EmailConversationStatePatch = {};
  for (const [key, value] of Object.entries(result.validatedSlotUpdates)) {
    (slotPatch as Record<string, unknown>)[key] = value;
  }

  await updateEmailConversationState(conversation.id, {
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
