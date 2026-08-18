import { desc, eq } from "drizzle-orm";
import { db, supportEmailConversationsTable, supportEmailConversationMessagesTable, type SupportEmailConversation, type SupportEmailConversationMessage } from "@luma/db";
import type { SarahPreviewRequestBody } from "../lib/support/types.js";

const MAX_HISTORY_MESSAGES = 20;

export interface SupportEmailConversationStatePatch {
  readonly prescriptionWritten?: boolean;
  readonly prescriptionWrittenAt?: Date;
  readonly orderShipped?: boolean;
  readonly orderShippedAt?: Date;
  readonly trackingNumber?: string | null;
  readonly reviewRequested?: boolean;
  readonly reviewSentiment?: "positive" | "neutral" | "negative" | null;
  readonly lastQuestion?: string | null;
  readonly pendingTopic?: string | null;
  readonly lastDraft?: string | null;
  readonly needsAttention?: boolean;
}

/** Email twin of support-conversations.service.ts's getOrCreateSupportConversation — its own table, same one-per-customer behavior. */
export async function getOrCreateSupportEmailConversation(personId: string): Promise<SupportEmailConversation> {
  const [existing] = await db.select().from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  if (existing) return existing;

  const [created] = await db
    .insert(supportEmailConversationsTable)
    .values({ personId })
    .onConflictDoNothing({ target: supportEmailConversationsTable.personId })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  return row;
}

export async function updateSupportEmailConversationState(conversationId: string, patch: SupportEmailConversationStatePatch): Promise<void> {
  await db.update(supportEmailConversationsTable).set(patch).where(eq(supportEmailConversationsTable.id, conversationId));
}

export async function appendSupportEmailMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  subject: string,
  body: string,
  opts: { sentiment?: "positive" | "neutral" | "negative" | null; messageId?: string | null; inReplyTo?: string | null } = {},
): Promise<SupportEmailConversationMessage> {
  const [row] = await db
    .insert(supportEmailConversationMessagesTable)
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

export async function setSupportEmailMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(supportEmailConversationMessagesTable).set({ sentiment }).where(eq(supportEmailConversationMessagesTable.id, messageId));
}

export async function listSupportEmailMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<SupportEmailConversationMessage[]> {
  const rows = await db
    .select()
    .from(supportEmailConversationMessagesTable)
    .where(eq(supportEmailConversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(supportEmailConversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Email twin of support-conversations.service.ts's toSarahPreviewBody — runSarahTurn is channel-agnostic and reused unchanged. */
export function toSupportEmailPreviewBody(conversation: SupportEmailConversation, history: readonly SupportEmailConversationMessage[]): SarahPreviewRequestBody {
  return {
    messages: history.map((m) => ({ direction: m.direction, body: m.body })),
    orderState: {
      prescriptionWritten: conversation.prescriptionWritten,
      orderShipped: conversation.orderShipped,
      trackingNumber: conversation.trackingNumber,
    },
    reviewRequested: conversation.reviewRequested,
    lastQuestion: conversation.lastQuestion,
    pendingTopic: conversation.pendingTopic,
    lastDraft: conversation.lastDraft,
  };
}
