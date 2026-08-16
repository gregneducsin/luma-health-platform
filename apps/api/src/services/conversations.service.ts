import { desc, eq, sql } from "drizzle-orm";
import { db, conversationsTable, conversationMessagesTable, customersTable, type Conversation, type ConversationMessage } from "@luma/db";
import type { BotPreviewRequestBody } from "../lib/messaging/types.js";

const MAX_HISTORY_MESSAGES = 20;

export interface ConversationStatePatch {
  readonly selectedProduct?: "semaglutide" | "tirzepatide" | null;
  readonly currentlyTaking?: "yes" | "no" | null;
  readonly wantsProcessExplanation?: "yes" | "no" | null;
  readonly hasTimeForIntake?: "yes" | "no" | null;
  readonly wantsPlanInclusions?: "yes" | "no" | null;
  readonly readyForForm?: "yes" | "no" | null;
  readonly lastQuestion?: string | null;
  readonly pendingTopic?: string | null;
  readonly lastDraft?: string | null;
  readonly objectionStage?: 0 | 1 | 2;
  readonly linkProvided?: boolean;
  readonly promoOffered?: boolean;
}

/** One conversation per customer. Creates it on first use (opener or inbound reply, whichever comes first). */
export async function getOrCreateConversation(personId: string): Promise<Conversation> {
  const [existing] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  if (existing) return existing;

  const [created] = await db
    .insert(conversationsTable)
    .values({ personId })
    .onConflictDoNothing({ target: conversationsTable.personId })
    .returning();
  if (created) return created;

  // Lost a create race to a concurrent call — the row now exists, fetch it.
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  return row;
}

export async function updateConversationState(conversationId: string, patch: ConversationStatePatch): Promise<void> {
  await db.update(conversationsTable).set(patch).where(eq(conversationsTable.id, conversationId));
}

export async function appendMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  body: string,
  opts: { sentiment?: "positive" | "neutral" | "negative" | null; providerMessageId?: string | null } = {},
): Promise<ConversationMessage> {
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({ conversationId, direction, body, sentiment: opts.sentiment ?? null, providerMessageId: opts.providerMessageId ?? null })
    .returning();
  return row;
}

export async function setMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(conversationMessagesTable).set({ sentiment }).where(eq(conversationMessagesTable.id, messageId));
}

export async function listMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<ConversationMessage[]> {
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Builds the shape runLucyTurn expects from persisted conversation state + recent history. */
export function toBotPreviewBody(conversation: Conversation, history: readonly ConversationMessage[]): BotPreviewRequestBody {
  return {
    messages: history.map((m) => ({ direction: m.direction, body: m.body })),
    currentSlots: {
      selectedProduct: conversation.selectedProduct,
      currentlyTaking: conversation.currentlyTaking,
      wantsProcessExplanation: conversation.wantsProcessExplanation,
      hasTimeForIntake: conversation.hasTimeForIntake,
      wantsPlanInclusions: conversation.wantsPlanInclusions,
      readyForForm: conversation.readyForForm,
    },
    lastQuestion: conversation.lastQuestion,
    pendingTopic: conversation.pendingTopic,
    lastDraft: conversation.lastDraft,
    objectionStage: conversation.objectionStage as 0 | 1 | 2,
    linkProvided: conversation.linkProvided,
    promoOffered: conversation.promoOffered,
  };
}

export interface ConversationSummary {
  readonly id: string;
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly status: "active" | "closed";
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastSentiment: "positive" | "neutral" | "negative" | null;
}

/** For the dashboard's Conversations tab: one row per conversation, most recently active first. */
export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: conversationsTable.id,
      personId: conversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      status: conversationsTable.status,
      lastMessageAt: sql<string | null>`(select max(${conversationMessagesTable.createdAt}) from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${conversationMessagesTable.body} from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id} order by ${conversationMessagesTable.createdAt} desc limit 1)`,
      lastSentiment: sql<string | null>`(select ${conversationMessagesTable.sentiment} from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id} and ${conversationMessagesTable.direction} = 'inbound' order by ${conversationMessagesTable.createdAt} desc limit 1)`,
    })
    .from(conversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, conversationsTable.personId))
    .orderBy(desc(sql`(select max(${conversationMessagesTable.createdAt}) from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id})`));

  return rows.map((r) => ({ ...r, lastSentiment: r.lastSentiment as ConversationSummary["lastSentiment"] }));
}

export async function getConversationDetail(
  conversationId: string,
): Promise<{ conversation: Conversation; customer: { firstName: string; lastName: string; phone: string | null }; messages: ConversationMessage[] } | null> {
  const [row] = await db
    .select({
      conversation: conversationsTable,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      phone: customersTable.phone,
    })
    .from(conversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, conversationsTable.personId))
    .where(eq(conversationsTable.id, conversationId));
  if (!row) return null;
  const messages = await listMessages(conversationId, 200);
  return { conversation: row.conversation, customer: { firstName: row.firstName, lastName: row.lastName, phone: row.phone }, messages };
}
