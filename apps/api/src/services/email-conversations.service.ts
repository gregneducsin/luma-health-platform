import { desc, eq } from "drizzle-orm";
import { db, emailConversationsTable, emailConversationMessagesTable, type EmailConversation, type EmailConversationMessage } from "@luma/db";
import type { BotPreviewRequestBody } from "../lib/messaging/types.js";

const MAX_HISTORY_MESSAGES = 20;

export interface EmailConversationStatePatch {
  readonly selectedProduct?: "semaglutide" | "tirzepatide" | null;
  readonly currentlyTaking?: "yes" | "no" | null;
  readonly wantsProcessExplanation?: "yes" | "no" | null;
  readonly hasTimeForIntake?: "yes" | "no" | null;
  readonly wantsPlanInclusions?: "yes" | "no" | null;
  readonly readyForForm?: "yes" | "no" | null;
  readonly state?: string | null;
  readonly lastQuestion?: string | null;
  readonly pendingTopic?: string | null;
  readonly lastDraft?: string | null;
  readonly objectionStage?: 0 | 1 | 2;
  readonly linkProvided?: boolean;
  readonly promoOffered?: boolean;
  readonly needsAttention?: boolean;
}

/**
 * Email twin of conversations.service.ts's getOrCreateConversation — same
 * one-per-customer, create-on-first-use behavior, its own table
 * (emailConversationsTable) so the SMS thread and the email thread for the
 * same person are tracked independently.
 */
export async function getOrCreateEmailConversation(
  personId: string,
  leadSource: "abandoned_cart" | "meta_form" = "abandoned_cart",
): Promise<EmailConversation> {
  const [existing] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  if (existing) return existing;

  const [created] = await db
    .insert(emailConversationsTable)
    .values({ personId, leadSource })
    .onConflictDoNothing({ target: emailConversationsTable.personId })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  return row;
}

export async function updateEmailConversationState(conversationId: string, patch: EmailConversationStatePatch): Promise<void> {
  await db.update(emailConversationsTable).set(patch).where(eq(emailConversationsTable.id, conversationId));
}

export async function appendEmailMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  subject: string,
  body: string,
  opts: { sentiment?: "positive" | "neutral" | "negative" | null; messageId?: string | null; inReplyTo?: string | null } = {},
): Promise<EmailConversationMessage> {
  const [row] = await db
    .insert(emailConversationMessagesTable)
    .values({
      conversationId,
      direction,
      subject,
      body,
      sentiment: opts.sentiment ?? null,
      messageId: opts.messageId ?? null,
      inReplyTo: opts.inReplyTo ?? null,
    })
    .returning();
  return row;
}

export async function setEmailMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(emailConversationMessagesTable).set({ sentiment }).where(eq(emailConversationMessagesTable.id, messageId));
}

export async function listEmailMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<EmailConversationMessage[]> {
  const rows = await db
    .select()
    .from(emailConversationMessagesTable)
    .where(eq(emailConversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(emailConversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/**
 * Builds the shape runLucyTurn expects, same as conversations.service.ts's
 * toBotPreviewBody — the pure conversation-guardrail logic doesn't know or
 * care which channel a turn came from, so an email turn feeds it exactly
 * the same body shape an SMS turn does. `body.body` here is the plain-text
 * subject+content, not the raw HTML.
 */
export function toEmailPreviewBody(conversation: EmailConversation, history: readonly EmailConversationMessage[]): BotPreviewRequestBody {
  return {
    messages: history.map((m) => ({ direction: m.direction, body: m.body })),
    leadSource: conversation.leadSource,
    currentSlots: {
      selectedProduct: conversation.selectedProduct,
      currentlyTaking: conversation.currentlyTaking,
      wantsProcessExplanation: conversation.wantsProcessExplanation,
      hasTimeForIntake: conversation.hasTimeForIntake,
      wantsPlanInclusions: conversation.wantsPlanInclusions,
      readyForForm: conversation.readyForForm,
      state: conversation.state,
    },
    lastQuestion: conversation.lastQuestion,
    pendingTopic: conversation.pendingTopic,
    lastDraft: conversation.lastDraft,
    objectionStage: conversation.objectionStage as 0 | 1 | 2,
    linkProvided: conversation.linkProvided,
    promoOffered: conversation.promoOffered,
  };
}
