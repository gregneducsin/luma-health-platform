import { and, eq, lte, sql } from "drizzle-orm";
import { db, customersTable, reviewRequestTriggersTable } from "@luma/db";
import { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } from "./support-conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderOrderReceivedMessage, renderPrescriptionWrittenMessage, renderOrderShippedMessage, renderReviewRequestMessage } from "../lib/support/templates.js";
import { logger } from "../lib/logger.js";

/**
 * ASSUMPTION pending owner confirmation: there's no explicit "delivered"
 * signal from Bask, so the review check-in fires a fixed delay after the
 * order-shipped event rather than off a real delivery-confirmation webhook
 * — same fixed-delay-off-the-last-known-event pattern as the abandoned-cart
 * opener. 5 days was chosen as a reasonable default (most orders should have
 * arrived by then); adjust REVIEW_REQUEST_DELAY_MS if that's wrong.
 */
const REVIEW_REQUEST_DELAY_MS = 5 * 24 * 60 * 60 * 1000;

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
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

  if (customer?.phone) {
    const text = renderOrderShippedMessage(customer.firstName, trackingNumber);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "order-shipped notice send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId }, "order-shipped notice not sent: no phone number on file");
  }

  await db
    .insert(reviewRequestTriggersTable)
    .values({ personId, dueAt: new Date(Date.now() + REVIEW_REQUEST_DELAY_MS) })
    .onConflictDoNothing({ target: reviewRequestTriggersTable.personId });
}

export interface ReviewRequestSweepResult {
  readonly sentCount: number;
  readonly failedCount: number;
}

/** Sends every due `pending` review-request trigger. Fully automated, no manual step. */
export async function sweepReviewRequestTriggers(): Promise<ReviewRequestSweepResult> {
  const dueTriggers = await db
    .select({ id: reviewRequestTriggersTable.id, personId: reviewRequestTriggersTable.personId })
    .from(reviewRequestTriggersTable)
    .where(and(eq(reviewRequestTriggersTable.status, "pending"), lte(reviewRequestTriggersTable.dueAt, sql`now()`)));

  let sentCount = 0;
  let failedCount = 0;

  for (const trigger of dueTriggers) {
    const customer = await getCustomerContact(trigger.personId);
    const conversation = await getOrCreateSupportConversation(trigger.personId);

    if (!customer?.phone) {
      await db.update(reviewRequestTriggersTable).set({ status: "failed", failureReason: "NO_PHONE_NUMBER" }).where(eq(reviewRequestTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    const text = renderReviewRequestMessage(customer.firstName);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
      await updateSupportConversationState(conversation.id, { reviewRequested: true });
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "sent", sentAt: sql`now()`, providerMessageId: result.providerMessageId })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      sentCount++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendSupportMessage(conversation.id, "outbound", text, {});
      await updateSupportConversationState(conversation.id, { reviewRequested: true });
      await db.update(reviewRequestTriggersTable).set({ status: "failed", failureReason: reason }).where(eq(reviewRequestTriggersTable.id, trigger.id));
      failedCount++;
    }
  }

  if (sentCount > 0 || failedCount > 0) {
    logger.info({ sentCount, failedCount }, "review-request sweep completed");
  }

  return { sentCount, failedCount };
}
