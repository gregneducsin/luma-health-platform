import { eq } from "drizzle-orm";
import { db, customersTable, conversationsTable, supportConversationsTable } from "@luma/db";
import { ibluSendMessageReceivedDataSchema, type IbluSendWebhookEnvelope } from "@luma/shared";
import { recordWebhookEventIfNew, markWebhookEventProcessed, markWebhookEventFailed } from "./webhooks.service.js";
import { processInboundMessage } from "./lucy-dispatch.service.js";
import { processInboundSupportMessage } from "./sarah-dispatch.service.js";
import { logger } from "../lib/logger.js";

async function findCustomerIdByPhone(phone: string): Promise<string | undefined> {
  const [row] = await db.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.phone, phone));
  return row?.id;
}

async function hasSupportConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: supportConversationsTable.id }).from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
  return Boolean(row);
}

async function hasLucyConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: conversationsTable.id }).from(conversationsTable).where(eq(conversationsTable.personId, personId));
  return Boolean(row);
}

/**
 * Decides which bot owns a real inbound text. A support conversation only
 * ever gets created off a real purchase/order event (see
 * getOrCreateSupportConversation's callers in order-fulfillment.service.ts)
 * — its mere existence means this person is a customer, not just a lead, so
 * Sarah owns anything from them from that point on, even if Lucy's
 * conversation is technically still open too. Falls back to Lucy only when
 * no support conversation exists yet.
 *
 * A person with neither a Lucy nor a Sarah conversation is texting in cold,
 * outside any relationship either bot has established — deliberately not
 * guessed at. No auto-reply is drafted; it's logged for staff to pick up
 * instead.
 */
async function dispatchInboundMessage(personId: string, body: string): Promise<void> {
  if (await hasSupportConversation(personId)) {
    await processInboundSupportMessage(personId, body);
    return;
  }
  if (await hasLucyConversation(personId)) {
    await processInboundMessage(personId, body);
    return;
  }
  logger.warn({ personId }, "inbound iBluSend message from a person with no Lucy or Sarah conversation — no auto-reply sent");
}

/**
 * Handles one iBluSend webhook delivery. Only "message.received" with
 * direction "incoming" triggers a bot turn; every other event type
 * (delivery receipts, reactions, contact/device events) is acknowledged and
 * otherwise ignored — iBluSend auto-disables an endpoint after 3
 * consecutive non-2xx responses, so an event type we don't act on yet must
 * still resolve to a clean ack, not an error.
 *
 * event_id (not data.message_id) is the idempotency key — iBluSend's docs:
 * delivery is at-least-once and event_id is "unique per occurrence and
 * stable across retries."
 */
export async function handleIbluSendWebhook(envelope: IbluSendWebhookEnvelope): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("iblusend_message", envelope.event_id, envelope);
  if (!recorded) return { duplicate: true };

  try {
    if (envelope.event === "message.received") {
      const parsed = ibluSendMessageReceivedDataSchema.safeParse(envelope.data);
      if (!parsed.success) {
        throw new Error(`message.received payload failed validation: ${parsed.error.message}`);
      }
      const data = parsed.data;
      if (data.direction === "incoming" && data.content) {
        const personId = await findCustomerIdByPhone(data.phone_number);
        if (personId) {
          await dispatchInboundMessage(personId, data.content);
          await markWebhookEventProcessed(recorded.id, personId);
          return { duplicate: false };
        }
        logger.warn(
          { phoneLastFour: data.phone_number.slice(-4) },
          "inbound iBluSend message from an unrecognized phone number — no matching customer",
        );
      }
    }
    await markWebhookEventProcessed(recorded.id);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}
