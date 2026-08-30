import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable, conversationsTable, consumerAffairsTriggersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { scheduleLeadCheckin } from "./lead-checkin.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderConsumerAffairsOpener, renderConsumerAffairsFollowUp } from "../lib/messaging/follow-up-templates.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";

const OPENER_DELAY_MS = 10 * 60 * 1000;

/**
 * A failed send gets a few retries rather than being lost permanently —
 * same reasoning and mechanism as leadCheckinTriggersTable's sweep.
 */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Arms the one-time opener for a Consumer Affairs lead, 10 minutes after
 * their GHL webhook lands — see isConsumerAffairsLead in
 * webhooks.service.ts. onConflictDoNothing on personId means it's safe to
 * call this unconditionally on every GHL event for this person: only the
 * first call ever actually arms anything.
 */
export async function scheduleConsumerAffairsOpener(personId: string): Promise<void> {
  await db
    .insert(consumerAffairsTriggersTable)
    .values({ personId, dueAt: new Date(Date.now() + OPENER_DELAY_MS) })
    .onConflictDoNothing({ target: consumerAffairsTriggersTable.personId });
}

export interface ConsumerAffairsSweepResult {
  readonly sentCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
}

/**
 * Sends every due opener, plus any failed one that hasn't exhausted its
 * retry attempts and has cooled down since its last attempt. Skips
 * (cancels) a lead who already purchased or opted out by the time this
 * fires — rechecked now, not trusted from when the trigger was armed.
 *
 * Safe to call repeatedly, including from overlapping sweep runs — the
 * claim step atomically flips each due row to `processing` in a single
 * UPDATE before any SMS work happens, so two sweeps racing on the same due
 * trigger can't both send it. Same pattern as sweepLeadCheckinTriggers.
 */
export async function sweepConsumerAffairsTriggers(): Promise<ConsumerAffairsSweepResult> {
  const retryEligibleBefore = new Date(Date.now() - RETRY_COOLDOWN_MS);
  const claimed = await db
    .update(consumerAffairsTriggersTable)
    .set({ status: "processing" })
    .where(
      or(
        and(eq(consumerAffairsTriggersTable.status, "pending"), lte(consumerAffairsTriggersTable.dueAt, sql`now()`)),
        and(
          eq(consumerAffairsTriggersTable.status, "failed"),
          lt(consumerAffairsTriggersTable.attemptCount, MAX_SEND_ATTEMPTS),
          lte(consumerAffairsTriggersTable.updatedAt, retryEligibleBefore),
        ),
      ),
    )
    .returning({ id: consumerAffairsTriggersTable.id, personId: consumerAffairsTriggersTable.personId, attemptCount: consumerAffairsTriggersTable.attemptCount });

  let sentCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  for (const trigger of claimed) {
    const [purchased] = await db.select({ id: purchasesTable.id }).from(purchasesTable).where(and(eq(purchasesTable.customerId, trigger.personId), eq(purchasesTable.status, "completed"))).limit(1);
    if (purchased) {
      await db.update(consumerAffairsTriggersTable).set({ status: "cancelled", cancelledReason: "already_purchased" }).where(eq(consumerAffairsTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    if (await isCustomerSmsDnd(trigger.personId)) {
      await db.update(consumerAffairsTriggersTable).set({ status: "cancelled", cancelledReason: "opted_out" }).where(eq(consumerAffairsTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const [customer] = await db
      .select({ firstName: customersTable.firstName, phone: customersTable.phone })
      .from(customersTable)
      .where(eq(customersTable.id, trigger.personId));
    const nextAttemptCount = trigger.attemptCount + 1;

    if (!customer?.phone) {
      await db
        .update(consumerAffairsTriggersTable)
        .set({ status: "failed", failureReason: "NO_PHONE_NUMBER", attemptCount: nextAttemptCount })
        .where(eq(consumerAffairsTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    // Arms the 6-day check-in the moment we're about to send this lead's
    // first message — regardless of whether the send itself succeeds, same
    // as every other trigger-arming call in this codebase. No-op if a
    // check-in was already armed for this person (e.g. by a Meta opener).
    await scheduleLeadCheckin(trigger.personId);

    // A person can already have an active conversation by the time this
    // fires (e.g. they also came in as a Meta lead). Re-sending the full
    // intro reads as a robotic duplicate — see renderConsumerAffairsFollowUp.
    const [existingConversation] = await db.select({ id: conversationsTable.id }).from(conversationsTable).where(eq(conversationsTable.personId, trigger.personId));
    const text = existingConversation ? renderConsumerAffairsFollowUp(customer.firstName) : renderConsumerAffairsOpener(customer.firstName);
    const conversation = await getOrCreateConversation(trigger.personId);

    // The "sent" write below must happen right after a successful send,
    // before anything else that could throw — otherwise a failure in a
    // downstream step (logging into the conversation) falls into the catch,
    // marks this "failed", and a later sweep retries it: a real duplicate
    // text to the customer, even though the first one already went out.
    let result: { providerMessageId: string };
    try {
      result = await getSmsProvider().sendMessage(customer.phone, text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ personId: trigger.personId, reason }, "Consumer Affairs opener send failed");
      await appendMessage(conversation.id, "outbound", text, {});
      await db
        .update(consumerAffairsTriggersTable)
        .set({ status: "failed", failureReason: reason, attemptCount: nextAttemptCount })
        .where(eq(consumerAffairsTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    await db
      .update(consumerAffairsTriggersTable)
      .set({ status: "sent", sentAt: sql`now()`, providerMessageId: result.providerMessageId, attemptCount: nextAttemptCount })
      .where(eq(consumerAffairsTriggersTable.id, trigger.id));
    sentCount++;

    try {
      await appendMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId: trigger.personId, reason: err instanceof Error ? err.message : String(err) }, "failed to log Consumer Affairs opener into the conversation");
    }
  }

  if (sentCount > 0 || cancelledCount > 0 || failedCount > 0) {
    logger.info({ sentCount, cancelledCount, failedCount }, "Consumer Affairs opener sweep completed");
  }

  return { sentCount, cancelledCount, failedCount };
}
