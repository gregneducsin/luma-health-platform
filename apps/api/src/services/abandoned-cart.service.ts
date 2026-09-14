import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, abandonedCartTriggersTable, conversationsTable, customersTable, purchasesTable, questionnaireEventsTable } from "@luma/db";
import { getOrCreateConversation, appendMessage, updateConversationState } from "./conversations.service.js";
import { scheduleLeadCheckin } from "./lead-checkin.service.js";
import { hasClickedMostRecentIntakeLink } from "./intake-links.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderAbandonedCartOpener, renderAbandonedCartFollowUp, renderConsumerAffairsAbandonedCartOpener } from "../lib/messaging/follow-up-templates.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";

const OPENER_DELAY_MS = 10 * 60 * 1000;

/**
 * The Bask questionnaire ID for Consumer Affairs abandoned-checkout leads —
 * these get a different opener (renderConsumerAffairsAbandonedCartOpener)
 * calling out where they came from, and a dedicated promo link (see
 * consumer_affairs_20 in intake-links.service.ts) instead of the generic
 * abandoned-cart treatment.
 */
const CONSUMER_AFFAIRS_ABANDONED_QUESTIONNAIRE_ID = "9986";
const isConsumerAffairsAbandonedQuestionnaire = (questionnaireId: string): boolean => questionnaireId.trim() === CONSUMER_AFFAIRS_ABANDONED_QUESTIONNAIRE_ID;

export interface AbandonedCartSweepResult {
  readonly sentCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
}

/**
 * Arms the very first outbound message for a lead, 10 minutes after Bask
 * fires an `abandoned` questionnaire event — fully automated, 24/7, no
 * monitored-hours window. Idempotent: the unique index on
 * questionnaireEventId means a duplicate `abandoned` webhook delivery for
 * the *same* questionnaire event can't schedule (or send) a second opener.
 *
 * That alone doesn't cover a second, distinct questionnaire event for the
 * same person (e.g. a restarted/resubmitted questionnaire gets a new Bask
 * questionnaireId) — same gap as scheduleAbandonedCartEmailSequence, fixed
 * the same way: skip arming a second opener while one is already pending
 * for this person.
 */
export async function scheduleAbandonedCartOpener(personId: string, questionnaireEventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, personId)).for("update");

    const [existing] = await tx
      .select({ id: abandonedCartTriggersTable.id })
      .from(abandonedCartTriggersTable)
      .where(and(eq(abandonedCartTriggersTable.personId, personId), inArray(abandonedCartTriggersTable.status, ["pending", "processing"])))
      .limit(1);
    if (existing) return;

    await tx
      .insert(abandonedCartTriggersTable)
      .values({ personId, questionnaireEventId, dueAt: new Date(Date.now() + OPENER_DELAY_MS) })
      .onConflictDoNothing({ target: abandonedCartTriggersTable.questionnaireEventId });
  });
}

/**
 * Sends every due `pending` opener trigger, unless the lead is no longer
 * eligible (already purchased, or the questionnaire is no longer abandoned —
 * both rechecked right now, not trusted from when the trigger was armed).
 *
 * Safe to call repeatedly, including from overlapping sweep runs — see the
 * identical comment on sweepFollowUpJobs: the claim step atomically flips
 * each due row from `pending` to `processing` in a single UPDATE before any
 * SMS work happens, so two sweeps racing on the same due trigger can't both
 * send it.
 */
export async function sweepAbandonedCartTriggers(): Promise<AbandonedCartSweepResult> {
  const claimed = await db
    .update(abandonedCartTriggersTable)
    .set({ status: "processing" })
    .where(and(eq(abandonedCartTriggersTable.status, "pending"), lte(abandonedCartTriggersTable.dueAt, sql`now()`)))
    .returning({ id: abandonedCartTriggersTable.id, personId: abandonedCartTriggersTable.personId, questionnaireEventId: abandonedCartTriggersTable.questionnaireEventId });

  let sentCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  for (const trigger of claimed) {
    const eligible = await isStillEligible(trigger.personId, trigger.questionnaireEventId);

    if (!eligible.ok) {
      await db
        .update(abandonedCartTriggersTable)
        .set({ status: "cancelled", cancelledReason: eligible.reason })
        .where(eq(abandonedCartTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    // The person may already have clicked their intake link by the time this
    // fires — most commonly via the parallel abandoned-cart email sequence,
    // armed off the same event (abandoned-cart-email.service.ts), which
    // mints and sends a real clickable link in its opener email on the same
    // 10-minute delay. Sending "want me to send the link?" now reads as out
    // of touch — they're already in the Bask questionnaire, and clicking
    // already armed the provider_check_in follow-up 2 hours out (see
    // handleIntakeLinkClick in intake-links.service.ts), so this trigger
    // just steps aside for it. Unlike already_purchased/opted_out/
    // no_longer_abandoned above, this isn't an exit from the funnel, so the
    // 6-day lead check-in — normally armed inside sendOpener below, the only
    // place that does it for a Bask-only lead — still needs arming here.
    if (await hasClickedMostRecentIntakeLink(trigger.personId)) {
      await scheduleLeadCheckin(trigger.personId);
      await db
        .update(abandonedCartTriggersTable)
        .set({ status: "cancelled", cancelledReason: "already_clicked_intake_link" })
        .where(eq(abandonedCartTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const sendResult = await sendOpener(trigger.personId, trigger.questionnaireEventId);

    if (!sendResult.ok) {
      await db.update(abandonedCartTriggersTable).set({ status: "failed", failureReason: sendResult.reason }).where(eq(abandonedCartTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    await db
      .update(abandonedCartTriggersTable)
      .set({ status: "sent", sentAt: sql`now()`, providerMessageId: sendResult.providerMessageId })
      .where(eq(abandonedCartTriggersTable.id, trigger.id));
    sentCount++;
  }

  if (sentCount > 0 || cancelledCount > 0 || failedCount > 0) {
    logger.info({ sentCount, cancelledCount, failedCount }, "abandoned-cart opener sweep completed");
  }

  return { sentCount, cancelledCount, failedCount };
}

type EligibilityResult = { ok: true } | { ok: false; reason: string };

async function isStillEligible(personId: string, questionnaireEventId: string): Promise<EligibilityResult> {
  const [purchased] = await db.select({ id: purchasesTable.id }).from(purchasesTable).where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"))).limit(1);
  if (purchased) return { ok: false, reason: "already_purchased" };

  if (await isCustomerSmsDnd(personId)) return { ok: false, reason: "opted_out" };

  const [event] = await db.select({ status: questionnaireEventsTable.status }).from(questionnaireEventsTable).where(eq(questionnaireEventsTable.id, questionnaireEventId));
  if (!event || event.status !== "abandoned") return { ok: false, reason: "no_longer_abandoned" };

  return { ok: true };
}

type SendResult = { ok: true; providerMessageId: string | null } | { ok: false; reason: string };

async function sendOpener(personId: string, questionnaireEventId: string): Promise<SendResult> {
  const [customer] = await db
    .select({ firstName: customersTable.firstName, phone: customersTable.phone })
    .from(customersTable)
    .where(eq(customersTable.id, personId));
  if (!customer) {
    return { ok: false, reason: "CUSTOMER_NOT_FOUND" };
  }

  const [event] = await db.select({ questionnaireId: questionnaireEventsTable.questionnaireId }).from(questionnaireEventsTable).where(eq(questionnaireEventsTable.id, questionnaireEventId));
  const isConsumerAffairsCart = event !== undefined && isConsumerAffairsAbandonedQuestionnaire(event.questionnaireId);

  // Arms the 6-day check-in the moment we're about to send this lead's very
  // first message — regardless of whether the send itself succeeds, same as
  // every other trigger-arming call in this codebase. No-op if a check-in
  // was already armed for this person (e.g. by the Meta-lead opener).
  await scheduleLeadCheckin(personId);

  // The email side of this opener is a separate 4-step drip sequence with
  // its own schedule (abandoned-cart-email.service.ts), armed alongside
  // this SMS trigger in webhooks.service.ts, not sent from here.

  if (!customer.phone) {
    return { ok: false, reason: "NO_PHONE_NUMBER" };
  }

  // A person can already have an active conversation by the time their
  // questionnaire abandonment fires this opener — most commonly, they came
  // in as a Meta lead first and only later started (then abandoned) the
  // Bask questionnaire separately. Re-sending the full "Hi, this is Lucy"
  // opener into that same thread reads as a robotic duplicate introduction
  // — see renderAbandonedCartFollowUp's docstring. The abandoned-
  // questionnaire nudge itself is still real signal worth sending, just
  // without repeating the introduction.
  const [existingConversation] = await db.select({ id: conversationsTable.id }).from(conversationsTable).where(eq(conversationsTable.personId, personId));
  // Consumer Affairs framing only applies to the very first message — see
  // renderConsumerAffairsAbandonedCartOpener's docstring for why the
  // already-has-a-conversation path keeps the plain follow-up copy.
  const text = existingConversation
    ? renderAbandonedCartFollowUp(customer.firstName)
    : isConsumerAffairsCart
      ? renderConsumerAffairsAbandonedCartOpener(customer.firstName)
      : renderAbandonedCartOpener(customer.firstName);
  const conversation = await getOrCreateConversation(personId);
  const stateUpdate = !existingConversation && isConsumerAffairsCart ? { promoOffered: true, consumerAffairsCart: true } : { promoOffered: true };

  try {
    const result = await getSmsProvider().sendMessage(customer.phone, text);
    await appendMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId, deliveryStatus: "sent" });
    // The opener promises $20 off directly — the eventual send_form in the
    // reply-driven conversation must use the promo link, not the plain one.
    await updateConversationState(conversation.id, stateUpdate);
    return { ok: true, providerMessageId: result.providerMessageId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ personId, reason }, "abandoned-cart opener send failed");
    // Still logged for visibility even though the send failed — this is what
    // Lucy's opener would have said, once a provider exists.
    await appendMessage(conversation.id, "outbound", text, { deliveryStatus: "failed" });
    await updateConversationState(conversation.id, stateUpdate);
    return { ok: false, reason };
  }
}
