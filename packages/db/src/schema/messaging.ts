import { pgTable, text, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";

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

export type IntakeLinkToken = typeof intakeLinkTokensTable.$inferSelect;
export type FollowUpJob = typeof followUpJobsTable.$inferSelect;
