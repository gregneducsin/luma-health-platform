import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runSarahTurn, type SarahTurnResult } from "./sarah-conversation.service.js";
import {
  getOrCreateSupportEmailConversation,
  listSupportEmailMessages,
  appendSupportEmailMessage,
  setSupportEmailMessageSentiment,
  updateSupportEmailConversationState,
  toSupportEmailPreviewBody,
  type SupportEmailConversationStatePatch,
} from "./support-email-conversations.service.js";
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

const SIGN_OFF = "Sarah at Luma Health";

/** Unlike a text, an email reads as unfinished without a greeting and a sign-off — Claude drafts only the substantive reply body (same as it does for SMS), so this wraps it, not the model. */
function withGreetingAndSignOff(firstName: string, bodyText: string): string {
  const greeting = firstName.trim() ? `Hi ${firstName.trim()},` : "Hi,";
  return `${greeting}\n\n${bodyText}\n\n— ${SIGN_OFF}`;
}

/** Email twin of sarah-dispatch.service.ts's sendAndLog — same fail-soft and DND-checked-here reasoning as lucy-email-dispatch.service.ts's sendAndLog. */
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
    logger.warn({ personId, conversationId }, "outbound Sarah email not sent: customer is do-not-disturb");
    return;
  }

  const signedBody = withGreetingAndSignOff(firstName, bodyText);
  let messageId: string | null = null;
  try {
    const { provider, fromName } = getEmailProvider("sarah");
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
    logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Sarah email send failed");
  }
  await appendSupportEmailMessage(conversationId, "outbound", subject, signedBody, { messageId, inReplyTo });
}

/**
 * Email twin of sarah-dispatch.service.ts's processInboundSupportMessage —
 * same runSarahTurn guardrail pipeline unchanged, same combined-reply
 * adaptation as lucy-email-dispatch.service.ts (reply + nextQuestion sent
 * as one email, not two).
 */
export async function processInboundSupportEmail(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<SarahTurnResult> {
  return withPersonLock(personId, () => processInboundSupportEmailLocked(personId, subject, bodyText, messageId));
}

async function processInboundSupportEmailLocked(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<SarahTurnResult> {
  const conversation = await getOrCreateSupportEmailConversation(personId);
  const priorMessages = await listSupportEmailMessages(conversation.id);
  const inboundMessage = await appendSupportEmailMessage(conversation.id, "inbound", subject, bodyText, { messageId });

  const body = toSupportEmailPreviewBody(conversation, [...priorMessages, inboundMessage]);
  const result = await runSarahTurn(body);

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Sarah email turn rejected — no outbound email sent");
    await updateSupportEmailConversationState(conversation.id, { needsAttention: true });
    return result;
  }

  await setSupportEmailMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);
  const combinedBody = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t)).join("\n\n");
  if (combinedBody && customer) {
    await sendAndLog(personId, conversation.id, customer.email, customer.firstName, replySubject(subject), combinedBody, inboundMessage.messageId);
  }

  if (result.preCheckCode === "OPT_OUT") {
    await setCustomerEmailDnd(personId, true);
  }

  const statePatch: SupportEmailConversationStatePatch = {
    lastQuestion: result.nextQuestion,
    lastDraft: result.reply,
    ...(result.requiresStaff ? { needsAttention: true } : {}),
    ...(conversation.reviewRequested && result.inboundSentiment !== null ? { reviewSentiment: result.inboundSentiment } : {}),
  };
  await updateSupportEmailConversationState(conversation.id, statePatch);

  return result;
}
