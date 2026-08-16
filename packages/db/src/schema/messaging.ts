import { pgTable, text, uuid, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { questionnaireEventsTable } from "./webhooks";

/**
 * A one-time trigger link we generate and send to a lead (e.g. an
 * abandoned-questionnaire nudge). Clicking it redirects to the universal
 * Bask questionnaire URL (or its $20-off promo variant — see promoApplied)
 * and, on the first click only, arms a follow-up job due 2 hours later.
 * Only the SHA-256 hash of the raw token is ever stored — same convention as
 * session/invitation/password-reset tokens.
 */
export const intakeLinkTokensTable = pgTable(
  "intake_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /**
     * Which Bask URL variant this link redirects to. Decided at mint time
     * (e.g. by whether the Lucy conversation used the first_month_offer
     * topic before agreement), not at click time — the click happens hours
     * later with no memory of what was discussed.
     */
    promoApplied: text("promo_applied", { enum: ["none", "first_month_20"] }).notNull().default("none"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("intake_link_tokens_token_hash_key").on(t.tokenHash), index("intake_link_tokens_person_id_idx").on(t.personId)],
);

/**
 * A scheduled follow-up SMS, armed by the first click on an intake link.
 * A sweep sends `pending` jobs once due (via the SMS provider — see
 * lib/sms-provider.ts) unless the person already completed the
 * questionnaire or purchased in the meantime (`cancelled`), fully automated,
 * no manual step. `provider_check_in` fires 2 hours after the click; if it
 * sends successfully, `intake_questions_check_in` is scheduled 1 hour after
 * that (relative to the actual send, not the original click).
 */
export const followUpJobsTable = pgTable(
  "follow_up_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    intakeLinkTokenId: uuid("intake_link_token_id")
      .notNull()
      .references(() => intakeLinkTokensTable.id, { onDelete: "cascade" }),
    messageStep: text("message_step", { enum: ["provider_check_in", "intake_questions_check_in"] })
      .notNull()
      .default("provider_check_in"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("follow_up_jobs_token_message_step_key").on(t.intakeLinkTokenId, t.messageStep),
    index("follow_up_jobs_status_due_at_idx").on(t.status, t.dueAt),
    index("follow_up_jobs_person_id_idx").on(t.personId),
  ],
);

/**
 * One Lucy conversation thread per customer (1:1 for now — this is the
 * abandoned-cart bot, there's only one thread type). Holds the persisted
 * conversation state that used to be client-supplied per-call
 * (BotPreviewRequestBody) so a proactive opener and a later inbound reply
 * share the same state, and so a chat-log UI has something to read.
 */
export const conversationsTable = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
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
    /**
     * True whenever the most recent turn required staff attention — a
     * pre-check block (STOP/emergency/suitability/medical/legal), a
     * model-flagged staff_review, or a turn the guardrail rejected outright
     * (the customer got silence, not just a routed reply). Cleared by a
     * staff member reviewing the conversation, not automatically.
     */
    needsAttention: boolean("needs_attention").notNull().default(false),
    status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("conversations_person_id_key").on(t.personId), index("conversations_status_idx").on(t.status)],
);

/**
 * Every message in a conversation, in order. `sentiment` is set on inbound
 * messages only, tagged by the same Claude call that produces Lucy's reply
 * (no separate classification call).
 */
export const conversationMessagesTable = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Schedules the very first outbound message for a lead, armed when Bask
 * fires an `abandoned` questionnaire event. Fires 10 minutes later — fully
 * automated, 24/7, no monitored-hours window. One row per questionnaire
 * event (unique index), so a duplicate `abandoned` webhook delivery can't
 * double-send.
 */
export const abandonedCartTriggersTable = pgTable(
  "abandoned_cart_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    questionnaireEventId: uuid("questionnaire_event_id")
      .notNull()
      .references(() => questionnaireEventsTable.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("abandoned_cart_triggers_questionnaire_event_id_key").on(t.questionnaireEventId),
    index("abandoned_cart_triggers_status_due_at_idx").on(t.status, t.dueAt),
    index("abandoned_cart_triggers_person_id_idx").on(t.personId),
  ],
);

export type IntakeLinkToken = typeof intakeLinkTokensTable.$inferSelect;
export type FollowUpJob = typeof followUpJobsTable.$inferSelect;
export type Conversation = typeof conversationsTable.$inferSelect;
export type ConversationMessage = typeof conversationMessagesTable.$inferSelect;
export type AbandonedCartTrigger = typeof abandonedCartTriggersTable.$inferSelect;
