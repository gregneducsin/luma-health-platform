import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { db, customersTable, reviewRequestTriggersTable } from "@luma/db";
import { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } from "./support-conversations.service.js";
import { getOrCreateSupportEmailConversation, appendSupportEmailMessage } from "./support-email-conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderOrderReceivedMessage, renderPrescriptionWrittenMessage, renderOrderShippedMessage, renderReviewRequestMessage } from "../lib/support/templates.js";
import { renderOrderReceivedEmail, renderOrderShippedEmail, renderReviewRequestEmail } from "../lib/email/templates.js";
import { sendTriggerEmail } from "../lib/email/send-trigger-email.js";
import { logger } from "../lib/logger.js";
import { isCustomerDnd } from "./dnd.service.js";

/**
 * ASSUMPTION pending owner confirmation: there's no explicit "delivered"
 * signal from Bask, so the review check-in fires a fixed delay after the
 * order-shipped event rather than off a real delivery-confirmation webhook
 * — same fixed-delay-off-the-last-known-event pattern as the abandoned-cart
 * opener. 5 days was chosen as a reasonable default (most orders should have
 * arrived by then); adjust REVIEW_REQUEST_DELAY_MS if that's wrong.
 */
const REVIEW_REQUEST_DELAY_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * A failed send (SMS provider timeout, no phone on file yet, etc.) gets a
 * few more chances rather than being lost the moment it first fails — up to
 * MAX_SEND_ATTEMPTS total attempts, each at least RETRY_COOLDOWN_MS apart so
 * a flapping provider isn't hammered. After the cap, the row stays "failed"
 * permanently, same as before this retry mechanism existed.
 */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null; email: string } | undefined> {
  const [row] = await db
    .select({ firstName: customersTable.firstName, phone: customersTable.phone, email: customersTable.email })
    .from(customersTable)
    .where(eq(customersTable.id, personId));
  return row;
}

/**
 * Sends the order-received opener immediately — no sweep, no delay, same
 * "fire instantly" pattern as the Meta lead opener. Called synchronously
 * from handleBaskOrderWebhook. Failures are caught and logged, never thrown.
 */
export async function sendOrderReceivedOpener(personId: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  if (!customer?.phone) {
    logger.warn({ personId }, "order-received opener not sent: no phone number on file");
    return;
  }
  if (await isCustomerDnd(personId)) {
    logger.warn({ personId }, "order-received opener not sent: customer is do-not-disturb");
    return;
  }

  const text = renderOrderReceivedMessage(customer.firstName);
  const conversation = await getOrCreateSupportConversation(personId);

  try {
    const result = await getSmsProvider().sendMessage(customer.phone, text);
    await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ personId, reason }, "order-received opener send failed");
    await appendSupportMessage(conversation.id, "outbound", text, {});
  }

  const emailConversation = await getOrCreateSupportEmailConversation(personId);
  await sendTriggerEmail({
    persona: "sarah",
    personId,
    conversationId: emailConversation.id,
    email: customer.email,
    render: (unsubscribeUrl) => renderOrderReceivedEmail(customer.firstName, unsubscribeUrl),
    appendMessage: appendSupportEmailMessage,
    logLabel: "order-received",
  });
}

/** Fired synchronously from the prescription-written webhook handler. */
export async function handlePrescriptionWritten(personId: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  const conversation = await getOrCreateSupportConversation(personId);
  await updateSupportConversationState(conversation.id, { prescriptionWritten: true, prescriptionWrittenAt: new Date() });

  if (!customer?.phone) {
    logger.warn({ personId }, "prescription-written notice not sent: no phone number on file");
    return;
  }
  if (await isCustomerDnd(personId)) {
    logger.warn({ personId }, "prescription-written notice not sent: customer is do-not-disturb");
    return;
  }
  const text = renderPrescriptionWrittenMessage(customer.firstName);
  try {
    const result = await getSmsProvider().sendMessage(customer.phone, text);
    await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
  } catch (err) {
    logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "prescription-written notice send failed");
    await appendSupportMessage(conversation.id, "outbound", text, {});
  }
}

/**
 * Fired synchronously from the order-shipped webhook handler. Also arms the
 * post-delivery review check-in.
 */
export async function handleOrderShipped(personId: string, trackingNumber: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  const conversation = await getOrCreateSupportConversation(personId);
  await updateSupportConversationState(conversation.id, { orderShipped: true, orderShippedAt: new Date(), trackingNumber });

  const dnd = await isCustomerDnd(personId);
  if (customer?.phone && !dnd) {
    const text = renderOrderShippedMessage(customer.firstName, trackingNumber);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "order-shipped notice send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId, reason: dnd ? "do_not_disturb" : "no_phone_number" }, "order-shipped notice not sent");
  }

  if (customer) {
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await sendTriggerEmail({
      persona: "sarah",
      personId,
      conversationId: emailConversation.id,
      email: customer.email,
      render: (unsubscribeUrl) => renderOrderShippedEmail(customer.firstName, trackingNumber, unsubscribeUrl),
      appendMessage: appendSupportEmailMessage,
      logLabel: "order-shipped",
    });
  }

  await db
    .insert(reviewRequestTriggersTable)
    .values({ personId, dueAt: new Date(Date.now() + REVIEW_REQUEST_DELAY_MS) })
    .onConflictDoNothing({ target: reviewRequestTriggersTable.personId });
}

export interface ReviewRequestSweepResult {
  readonly sentCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
}

/**
 * Sends every due `pending` review-request trigger, plus any `failed`
 * trigger that hasn't exhausted its retry attempts and has cooled down
 * since its last attempt. Fully automated, no manual step.
 *
 * Safe to call repeatedly, including from overlapping sweep runs — see the
 * identical comment on sweepFollowUpJobs: the claim step atomically flips
 * each due row to `processing` in a single UPDATE before any SMS work
 * happens, so two sweeps racing on the same due trigger can't both send it.
 */
export async function sweepReviewRequestTriggers(): Promise<ReviewRequestSweepResult> {
  const retryEligibleBefore = new Date(Date.now() - RETRY_COOLDOWN_MS);
  const claimed = await db
    .update(reviewRequestTriggersTable)
    .set({ status: "processing" })
    .where(
      or(
        and(eq(reviewRequestTriggersTable.status, "pending"), lte(reviewRequestTriggersTable.dueAt, sql`now()`)),
        and(
          eq(reviewRequestTriggersTable.status, "failed"),
          lt(reviewRequestTriggersTable.attemptCount, MAX_SEND_ATTEMPTS),
          lte(reviewRequestTriggersTable.updatedAt, retryEligibleBefore),
        ),
      ),
    )
    .returning({ id: reviewRequestTriggersTable.id, personId: reviewRequestTriggersTable.personId, attemptCount: reviewRequestTriggersTable.attemptCount });

  let sentCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;

  for (const trigger of claimed) {
    if (await isCustomerDnd(trigger.personId)) {
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "cancelled", cancelledReason: "opted_out" })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const customer = await getCustomerContact(trigger.personId);
    const conversation = await getOrCreateSupportConversation(trigger.personId);
    const nextAttemptCount = trigger.attemptCount + 1;

    if (!customer?.phone) {
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "failed", failureReason: "NO_PHONE_NUMBER", attemptCount: nextAttemptCount })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    const text = renderReviewRequestMessage(customer.firstName);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
      // Only flip reviewRequested on an actual successful send — setting it
      // on a failed attempt (as this used to) made Sarah's conversation loop
      // treat the patient's next reply as a sentiment answer to a review
      // check-in question they were never actually sent.
      await updateSupportConversationState(conversation.id, { reviewRequested: true });
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "sent", sentAt: sql`now()`, providerMessageId: result.providerMessageId, attemptCount: nextAttemptCount })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      sentCount++;

      const emailConversation = await getOrCreateSupportEmailConversation(trigger.personId);
      await sendTriggerEmail({
        persona: "sarah",
        personId: trigger.personId,
        conversationId: emailConversation.id,
        email: customer.email,
        render: (unsubscribeUrl) => renderReviewRequestEmail(customer.firstName, unsubscribeUrl),
        appendMessage: appendSupportEmailMessage,
        logLabel: "review-request",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendSupportMessage(conversation.id, "outbound", text, {});
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "failed", failureReason: reason, attemptCount: nextAttemptCount })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      failedCount++;
    }
  }

  if (sentCount > 0 || failedCount > 0 || cancelledCount > 0) {
    logger.info({ sentCount, failedCount, cancelledCount }, "review-request sweep completed");
  }

  return { sentCount, failedCount, cancelledCount };
}
