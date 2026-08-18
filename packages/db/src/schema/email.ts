import { pgTable, text, uuid, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { questionnaireEventsTable } from "./webhooks";

/**
 * Email twin of conversationsTable (messaging.ts) — one Lucy email thread per
 * customer (1:1), same slot/state shape, same guardrail pipeline
 * (runLucyTurn is channel-agnostic and is reused unchanged for email turns).
 * Kept as its own table rather than adding a "channel" column to
 * conversationsTable: lower risk, ships without touching the SMS schema or
 * any of the routes/tests that assume one SMS conversation per person today.
 */
export const emailConversationsTable = pgTable(
  "email_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    leadSource: text("lead_source", { enum: ["abandoned_cart", "meta_form"] }).notNull().default("abandoned_cart"),
    state: text("state"),
    selectedProduct: text("selected_product", { enum: ["semaglutide", "tirzepatide"] }),
    currentlyTaking: text("currently_taking", { enum: ["yes", "no"] }),
    wantsProcessExplanation: text("wants_process_explanation", { enum: ["yes", "no"] }),
    hasTimeForIntake: text("has_time_for_intake", { enum: ["yes", "no"] }),
    wantsPlanInclusions: text("wants_plan_inclusions", { enum: ["yes", "no"] }),
    readyForForm: text("ready_for_form", { enum: ["yes", "no"] }),
    lastQuestion: text("last_question"),
    pendingTopic: text("pending_topic"),
    lastDraft: text("last_draft"),
    objectionStage: integer("objection_stage").notNull().default(0),
    linkProvided: boolean("link_provided").notNull().default(false),
    promoOffered: boolean("promo_offered").notNull().default(false),
    needsAttention: boolean("needs_attention").notNull().default(false),
    status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("email_conversations_person_id_key").on(t.personId), index("email_conversations_status_idx").on(t.status)],
);

/**
 * Every message in an email conversation, in order. `messageId`/`inReplyTo`
 * are RFC 5322 Message-ID header values (not a provider-assigned send id
 * like SMS's providerMessageId) — captured on both directions so replies
 * thread correctly in the customer's mail client and so IMAP-polled inbound
 * mail can be deduped/matched by header rather than by content.
 */
export const emailConversationMessagesTable = pgTable(
  "email_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => emailConversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/** Email twin of supportConversationsTable (support.ts) — one Sarah email thread per customer (1:1). */
export const supportEmailConversationsTable = pgTable(
  "support_email_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    prescriptionWritten: boolean("prescription_written").notNull().default(false),
    prescriptionWrittenAt: timestamp("prescription_written_at", { withTimezone: true }),
    orderShipped: boolean("order_shipped").notNull().default(false),
    orderShippedAt: timestamp("order_shipped_at", { withTimezone: true }),
    trackingNumber: text("tracking_number"),
    reviewRequested: boolean("review_requested").notNull().default(false),
    reviewSentiment: text("review_sentiment", { enum: ["positive", "neutral", "negative"] }),
    lastQuestion: text("last_question"),
    pendingTopic: text("pending_topic"),
    lastDraft: text("last_draft"),
    needsAttention: boolean("needs_attention").notNull().default(false),
    status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("support_email_conversations_person_id_key").on(t.personId), index("support_email_conversations_status_idx").on(t.status)],
);

/** Email twin of supportConversationMessagesTable (support.ts). */
export const supportEmailConversationMessagesTable = pgTable(
  "support_email_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => supportEmailConversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_email_conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/**
 * The 4-step abandoned-cart email nurture sequence — a distinct schedule
 * from the SMS abandoned-cart opener (abandonedCartTriggersTable), all
 * timed off the same abandonment event but on its own cadence: opener
 * (10 min), urgency (24 hr), educational (7 days), plan_comparison
 * (10 days). One row per step per abandonment event (unique on
 * questionnaireEventId+step), so a duplicate `abandoned` webhook delivery
 * can't double-schedule any step, and each step is independently
 * claimable/cancellable — a later step can still be cancelled (e.g. the
 * lead purchased) even after an earlier step already sent.
 */
export const abandonedCartEmailTriggersTable = pgTable(
  "abandoned_cart_email_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    questionnaireEventId: uuid("questionnaire_event_id")
      .notNull()
      .references(() => questionnaireEventsTable.id, { onDelete: "cascade" }),
    step: text("step", { enum: ["opener", "urgency", "educational", "plan_comparison"] }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state — see the identical comment on
    // followUpJobsTable.status (messaging.ts).
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    messageId: text("message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("abandoned_cart_email_triggers_event_step_key").on(t.questionnaireEventId, t.step),
    index("abandoned_cart_email_triggers_status_due_at_idx").on(t.status, t.dueAt),
    index("abandoned_cart_email_triggers_person_id_idx").on(t.personId),
  ],
);

export type EmailConversation = typeof emailConversationsTable.$inferSelect;
export type EmailConversationMessage = typeof emailConversationMessagesTable.$inferSelect;
export type SupportEmailConversation = typeof supportEmailConversationsTable.$inferSelect;
export type SupportEmailConversationMessage = typeof supportEmailConversationMessagesTable.$inferSelect;
export type AbandonedCartEmailTrigger = typeof abandonedCartEmailTriggersTable.$inferSelect;
