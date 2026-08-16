import { and, eq, sql } from "drizzle-orm";
import {
  db,
  webhookEventsTable,
  customersTable,
  externalIdentitiesTable,
  purchasesTable,
  questionnaireEventsTable,
  failedPaymentEventsTable,
  type WebhookEvent,
} from "@luma/db";
import type {
  GhlLeadWebhookRequest,
  BaskOrderWebhookRequest,
  BaskQuestionnaireWebhookRequest,
  BaskPaymentFailedWebhookRequest,
  BaskPrescriptionWrittenWebhookRequest,
  BaskOrderShippedWebhookRequest,
} from "@luma/shared";
import { scheduleAbandonedCartOpener } from "./abandoned-cart.service.js";
import { sendMetaLeadOpener } from "./meta-lead.service.js";
import { sendOrderReceivedOpener, handlePrescriptionWritten, handleOrderShipped } from "./order-fulfillment.service.js";

/**
 * Case-insensitive exact email match — NOT ilike(), which treats `_` and `%`
 * in the pattern as live SQL wildcards. `_` in particular is an ordinary,
 * common character in an email local-part (john_doe@example.com), so an
 * ilike() lookup on a webhook-supplied email could match a completely
 * different real customer's email that merely fits the wildcard pattern,
 * misattributing one person's order/prescription/tracking data to another.
 * lower()-equality has no wildcard semantics at all.
 */
function caseInsensitiveEmailEq(email: string) {
  return sql`lower(${customersTable.email}) = lower(${email})`;
}

// ── Shared idempotency + audit-log helpers ──────────────────────────────────

/**
 * Atomically records a webhook delivery. Returns null if (source,
 * externalEventId) was already recorded — the caller should treat that as
 * a successful no-op replay (return 200 without reprocessing), not an error.
 */
export async function recordWebhookEventIfNew(
  source: WebhookEvent["source"],
  externalEventId: string,
  rawPayload: unknown,
): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(webhookEventsTable)
    .values({ source, externalEventId, rawPayload: rawPayload as Record<string, unknown> })
    .onConflictDoNothing({ target: [webhookEventsTable.source, webhookEventsTable.externalEventId] })
    .returning({ id: webhookEventsTable.id });
  return row ?? null;
}

export async function markWebhookEventProcessed(id: string, personId?: string): Promise<void> {
  await db
    .update(webhookEventsTable)
    .set({ status: "processed", processedAt: new Date(), ...(personId ? { personId } : {}) })
    .where(eq(webhookEventsTable.id, id));
}

export async function markWebhookEventFailed(id: string, errorMessage: string): Promise<void> {
  await db
    .update(webhookEventsTable)
    .set({ status: "failed", processedAt: new Date(), errorMessage })
    .where(eq(webhookEventsTable.id, id));
}

/**
 * Matches an existing customer by (system, externalId) first, falling back
 * to a case-insensitive email match, and creates a new customer if neither
 * matches. Links the external identity either way (idempotent) so future
 * webhooks for the same external contact resolve directly.
 */
export async function findOrCreateCustomerByExternalIdentity(params: {
  system: string;
  externalId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  leadReceivedDate: string;
  leadType?: string;
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [byIdentity] = await tx
      .select({ personId: externalIdentitiesTable.personId })
      .from(externalIdentitiesTable)
      .where(and(eq(externalIdentitiesTable.system, params.system), eq(externalIdentitiesTable.externalId, params.externalId)));
    if (byIdentity) return { id: byIdentity.personId };

    const [byEmail] = await tx.select({ id: customersTable.id }).from(customersTable).where(caseInsensitiveEmailEq(params.email));

    const customerId = byEmail
      ? byEmail.id
      : (
          await tx
            .insert(customersTable)
            .values({
              firstName: params.firstName ?? "Unknown",
              lastName: params.lastName ?? "Unknown",
              email: params.email,
              phone: params.phone,
              leadReceivedDate: params.leadReceivedDate,
              leadType: params.leadType ?? "Other / Unknown",
              leadCreatedAt: new Date(),
            })
            .returning({ id: customersTable.id })
        )[0]!.id;

    await tx
      .insert(externalIdentitiesTable)
      .values({ personId: customerId, system: params.system, externalId: params.externalId })
      .onConflictDoNothing({ target: [externalIdentitiesTable.system, externalIdentitiesTable.externalId] });

    return { id: customerId };
  });
}

/** Best-effort match only — does not create a customer. Used by the
 * payment-failed handler, since a failed payment isn't itself a lead
 * signal strong enough to justify creating a new customer record. */
async function tryFindCustomerByExternalIdentityOrEmail(system: string, externalId: string, email?: string): Promise<string | undefined> {
  const [byIdentity] = await db
    .select({ personId: externalIdentitiesTable.personId })
    .from(externalIdentitiesTable)
    .where(and(eq(externalIdentitiesTable.system, system), eq(externalIdentitiesTable.externalId, externalId)));
  if (byIdentity) return byIdentity.personId;

  if (email) {
    const [byEmail] = await db.select({ id: customersTable.id }).from(customersTable).where(caseInsensitiveEmailEq(email));
    if (byEmail) return byEmail.id;
  }
  return undefined;
}

// ── Per-source handlers ─────────────────────────────────────────────────────

const occurredDate = (iso: string) => iso.slice(0, 10);

/** The exact leadType value GHL sends for a Meta (Facebook/Instagram) lead-gen form submission. */
const META_FORM_FILL_LEAD_TYPE = "meta form fill";
const isMetaFormFillLead = (leadType?: string): boolean => (leadType ?? "").trim().toLowerCase() === META_FORM_FILL_LEAD_TYPE;

export async function handleGhlLeadWebhook(payload: GhlLeadWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("ghl_lead", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "ghl",
      externalId: payload.contactId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
      leadType: payload.leadType,
    });

    // Meta form-fill leads are cold outreach — respond as fast as possible,
    // so the opener fires synchronously on this same request, not off a
    // scheduled sweep like the abandoned-cart trigger.
    if (isMetaFormFillLead(payload.leadType)) {
      await sendMetaLeadOpener(customerId);
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

export async function handleBaskOrderWebhook(payload: BaskOrderWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_order", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const purchaseDate = occurredDate(payload.purchasedAt);
    const amountPaid = typeof payload.amountPaid === "number" ? payload.amountPaid.toFixed(2) : payload.amountPaid;

    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: purchaseDate,
    });

    await db.transaction(async (tx) => {
      const [earlier] = await tx
        .select({ id: purchasesTable.id })
        .from(purchasesTable)
        .where(eq(purchasesTable.customerId, customerId));

      await tx.insert(purchasesTable).values({
        customerId,
        purchaseDate,
        orderNumber: payload.orderId,
        productName: payload.productName,
        amountPaid,
        ecommerceOrderId: payload.ecommerceOrderId ?? payload.transactionId,
        orderClassification: earlier ? "recurring" : "first_order",
        orderClassificationSource: "bask",
      });
    });

    // Sarah's opening "doctor is reviewing it" message fires the moment the
    // order lands — instant, same as the Meta lead opener, not a scheduled sweep.
    await sendOrderReceivedOpener(customerId);

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

export async function handleBaskPrescriptionWrittenWebhook(payload: BaskPrescriptionWrittenWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_prescription_written", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
    });

    await handlePrescriptionWritten(customerId);

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

export async function handleBaskOrderShippedWebhook(payload: BaskOrderShippedWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_order_shipped", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
    });

    await handleOrderShipped(customerId, payload.trackingNumber);

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

// Only used at customer-creation time (findOrCreateCustomerByExternalIdentity
// never overwrites leadType on an existing match) — reflects the funnel
// stage of whichever questionnaire event happens to arrive first for a
// person who isn't already a customer.
const BASK_QUESTIONNAIRE_LEAD_TYPES: Record<BaskQuestionnaireWebhookRequest["status"], string> = {
  started: "Bask questionnaire started",
  abandoned: "Bask abandoned cart",
  submitted: "Bask questionnaire submitted",
};

export async function handleBaskQuestionnaireWebhook(payload: BaskQuestionnaireWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_questionnaire", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
      leadType: BASK_QUESTIONNAIRE_LEAD_TYPES[payload.status],
    });

    const now = new Date(occurredAt);
    const [event] = await db
      .insert(questionnaireEventsTable)
      .values({
        personId: customerId,
        questionnaireId: payload.questionnaireId,
        status: payload.status,
        externalPersonId: payload.externalPersonId,
        startedAt: payload.status === "started" ? now : undefined,
        abandonedAt: payload.status === "abandoned" ? now : undefined,
        lastEventAt: now,
      })
      .onConflictDoUpdate({
        target: [questionnaireEventsTable.personId, questionnaireEventsTable.questionnaireId],
        set: {
          status: payload.status,
          lastEventAt: now,
          ...(payload.status === "abandoned" ? { abandonedAt: now } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: questionnaireEventsTable.id });

    // Arms the first Lucy outreach 10 minutes from now. Idempotent per
    // questionnaire event, so a duplicate "abandoned" delivery for the same
    // questionnaire can't double-schedule.
    if (payload.status === "abandoned") {
      await scheduleAbandonedCartOpener(customerId, event.id);
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

export async function handleBaskPaymentFailedWebhook(payload: BaskPaymentFailedWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_payment_failed", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const customerId = await tryFindCustomerByExternalIdentityOrEmail("bask", payload.externalPersonId, payload.email);

    await db.insert(failedPaymentEventsTable).values({
      externalEventId: payload.eventId,
      transactionId: payload.transactionId,
      personId: customerId,
      externalPersonId: payload.externalPersonId,
      amount: payload.amount,
      failureDate: new Date(payload.failureDate),
      paymentMethodType: payload.paymentMethodType,
      cardBrand: payload.cardBrand,
      cardLast4: payload.cardLast4,
      transactionResponse: payload.transactionResponse,
      sourceStatus: payload.sourceStatus,
      testMode: payload.testMode ?? false,
      rawPayload: payload,
    });

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}
