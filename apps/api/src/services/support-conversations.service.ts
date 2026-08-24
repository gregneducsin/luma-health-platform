import { desc, eq, sql } from "drizzle-orm";
import { db, supportConversationsTable, supportConversationMessagesTable, customersTable, type SupportConversation, type SupportConversationMessage } from "@luma/db";
import type { SarahPreviewRequestBody } from "../lib/support/types.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";

const MAX_HISTORY_MESSAGES = 20;

export interface SupportConversationStatePatch {
  readonly prescriptionWritten?: boolean;
  readonly prescriptionWrittenAt?: Date;
  readonly orderShipped?: boolean;
  readonly orderShippedAt?: Date;
  readonly trackingNumber?: string | null;
  readonly paymentFailed?: boolean;
  readonly paymentFailedAt?: Date;
  readonly reviewRequested?: boolean;
  readonly reviewSentiment?: "positive" | "neutral" | "negative" | null;
  readonly lastQuestion?: string | null;
  readonly pendingTopic?: string | null;
  readonly lastDraft?: string | null;
  readonly needsAttention?: boolean;
  readonly needsAttentionReason?: string | null;
}

/** One support conversation per customer. Creates it on first use (order-received opener or inbound reply). */
export async function getOrCreateSupportConversation(personId: string): Promise<SupportConversation> {
  const [existing] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
  if (existing) return existing;

  const [created] = await db
    .insert(supportConversationsTable)
    .values({ personId })
    .onConflictDoNothing({ target: supportConversationsTable.personId })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
  return row;
}

export async function updateSupportConversationState(conversationId: string, patch: SupportConversationStatePatch): Promise<void> {
  // Only worth the extra read when this patch is actually raising the flag —
  // every other patch (order state, review sentiment, etc.) skips it. Reads
  // the pre-update value so a conversation that's already flagged doesn't
  // re-alert on every subsequent message while it's still open.
  if (patch.needsAttention === true) {
    const [before] = await db
      .select({ needsAttention: supportConversationsTable.needsAttention, firstName: customersTable.firstName, lastName: customersTable.lastName })
      .from(supportConversationsTable)
      .innerJoin(customersTable, eq(customersTable.id, supportConversationsTable.personId))
      .where(eq(supportConversationsTable.id, conversationId));
    await db.update(supportConversationsTable).set(patch).where(eq(supportConversationsTable.id, conversationId));
    if (before && !before.needsAttention) {
      void notifySlack(`Needs attention (text) — ${before.firstName} ${before.lastName}: ${patch.needsAttentionReason ?? "no reason given"}`);
    }
    return;
  }
  await db.update(supportConversationsTable).set(patch).where(eq(supportConversationsTable.id, conversationId));
}

export async function clearSupportNeedsAttention(conversationId: string): Promise<void> {
  await db.update(supportConversationsTable).set({ needsAttention: false, needsAttentionReason: null }).where(eq(supportConversationsTable.id, conversationId));
}

export type StaffReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "no_phone" | "send_failed" };

/**
 * A human-authored reply, sent through the same SMS provider Sarah uses and
 * logged into the same conversation timeline the same way a bot reply is
 * (direction: "outbound") — so the CRM history reads as one continuous
 * conversation regardless of who actually wrote each message. Only clears
 * needsAttention on an actual successful send: a send failure means the
 * conversation still needs attention, not less of it.
 *
 * The message is logged even when the send fails (providerMessageId null) —
 * a transport failure doesn't erase the fact that this is what staff
 * actually tried to say; the caller still gets sent: false so the UI can
 * show the failure.
 */
export async function sendStaffReply(conversationId: string, body: string): Promise<StaffReplyResult> {
  const detail = await getSupportConversationDetail(conversationId);
  if (!detail) return { sent: false, reason: "not_found" };
  if (!detail.customer.phone) return { sent: false, reason: "no_phone" };

  let providerMessageId: string | null = null;
  let sendFailed = false;
  try {
    const result = await getSmsProvider().sendMessage(detail.customer.phone, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    sendFailed = true;
    logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "staff reply send failed");
  }

  await appendSupportMessage(conversationId, "outbound", body, { providerMessageId });
  if (sendFailed) return { sent: false, reason: "send_failed" };

  await clearSupportNeedsAttention(conversationId);
  return { sent: true };
}

export async function appendSupportMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  body: string,
  opts: { sentiment?: "positive" | "neutral" | "negative" | null; providerMessageId?: string | null } = {},
): Promise<SupportConversationMessage> {
  const [row] = await db
    .insert(supportConversationMessagesTable)
    .values({ conversationId, direction, body, sentiment: opts.sentiment ?? null, providerMessageId: opts.providerMessageId ?? null })
    .returning();
  return row;
}

export async function setSupportMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(supportConversationMessagesTable).set({ sentiment }).where(eq(supportConversationMessagesTable.id, messageId));
}

export async function listSupportMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<SupportConversationMessage[]> {
  const rows = await db
    .select()
    .from(supportConversationMessagesTable)
    .where(eq(supportConversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(supportConversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Builds the shape runSarahTurn expects from persisted conversation state + recent history. */
export function toSarahPreviewBody(conversation: SupportConversation, history: readonly SupportConversationMessage[]): SarahPreviewRequestBody {
  return {
    messages: history.map((m) => ({ direction: m.direction, body: m.body })),
    orderState: {
      prescriptionWritten: conversation.prescriptionWritten,
      orderShipped: conversation.orderShipped,
      trackingNumber: conversation.trackingNumber,
      paymentFailed: conversation.paymentFailed,
    },
    reviewRequested: conversation.reviewRequested,
    lastQuestion: conversation.lastQuestion,
    pendingTopic: conversation.pendingTopic,
    lastDraft: conversation.lastDraft,
  };
}

export interface SupportConversationSummary {
  readonly id: string;
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly status: "active" | "closed";
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastSentiment: "positive" | "neutral" | "negative" | null;
  readonly needsAttention: boolean;
}

/** For the dashboard's Support tab: one row per conversation, most recently active first. */
export async function listSupportConversationSummaries(): Promise<SupportConversationSummary[]> {
  const rows = await db
    .select({
      id: supportConversationsTable.id,
      personId: supportConversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      status: supportConversationsTable.status,
      needsAttention: supportConversationsTable.needsAttention,
      lastMessageAt: sql<string | null>`(select max(${supportConversationMessagesTable.createdAt}) from ${supportConversationMessagesTable} where ${supportConversationMessagesTable.conversationId} = ${supportConversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${supportConversationMessagesTable.body} from ${supportConversationMessagesTable} where ${supportConversationMessagesTable.conversationId} = ${supportConversationsTable.id} order by ${supportConversationMessagesTable.createdAt} desc limit 1)`,
      lastSentiment: sql<string | null>`(select ${supportConversationMessagesTable.sentiment} from ${supportConversationMessagesTable} where ${supportConversationMessagesTable.conversationId} = ${supportConversationsTable.id} and ${supportConversationMessagesTable.direction} = 'inbound' order by ${supportConversationMessagesTable.createdAt} desc limit 1)`,
    })
    .from(supportConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, supportConversationsTable.personId))
    .orderBy(desc(sql`(select max(${supportConversationMessagesTable.createdAt}) from ${supportConversationMessagesTable} where ${supportConversationMessagesTable.conversationId} = ${supportConversationsTable.id})`));

  return rows.map((r) => ({ ...r, lastSentiment: r.lastSentiment as SupportConversationSummary["lastSentiment"] }));
}

export async function getSupportConversationDetail(
  conversationId: string,
): Promise<{ conversation: SupportConversation; customer: { firstName: string; lastName: string; phone: string | null }; messages: SupportConversationMessage[] } | null> {
  const [row] = await db
    .select({
      conversation: supportConversationsTable,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      phone: customersTable.phone,
    })
    .from(supportConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, supportConversationsTable.personId))
    .where(eq(supportConversationsTable.id, conversationId));
  if (!row) return null;
  const messages = await listSupportMessages(conversationId, 200);
  return { conversation: row.conversation, customer: { firstName: row.firstName, lastName: row.lastName, phone: row.phone }, messages };
}
