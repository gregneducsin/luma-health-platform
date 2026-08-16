import { z } from "zod";

// ── GoHighLevel lead webhook ──────────────────────────────────────────────────

export const ghlLeadWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  contactId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1).optional(),
  leadType: z.string().min(1).optional(),
  // Optional because some GHL workflow templates don't forward a timestamp
  // merge field — the handler defaults this to the time the webhook was
  // received, same pattern as the Bask questionnaire webhook.
  occurredAt: z.string().datetime().optional(),
});
export type GhlLeadWebhookRequest = z.infer<typeof ghlLeadWebhookRequestSchema>;

// ── Bask order webhook ────────────────────────────────────────────────────────

export const baskOrderWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  // Bask's own field name — matches its native payload, not our internal
  // purchases.orderNumber column name. The handler maps orderId -> orderNumber.
  orderId: z.string().min(1),
  productName: z.string().min(1),
  // Bask sends this as a JSON number; other sources may send a formatted
  // string. The handler normalizes either to a fixed 2-decimal string.
  amountPaid: z.union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()]),
  // A single full timestamp — the handler derives both the purchase date
  // (date-only) and the webhook-event occurred date from this one field,
  // since Bask only provides one timestamp, not two.
  purchasedAt: z.string().datetime(),
  ecommerceOrderId: z.string().min(1).optional(),
  // Bask's own transaction identifier — used as ecommerceOrderId when that
  // field isn't separately provided.
  transactionId: z.string().min(1).optional(),
});
export type BaskOrderWebhookRequest = z.infer<typeof baskOrderWebhookRequestSchema>;

// ── Bask questionnaire webhook ─────────────────────────────────────────────────

export const baskQuestionnaireWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  questionnaireId: z.string().min(1),
  status: z.enum(["started", "abandoned", "submitted"]),
  // Optional because some source integrations (e.g. a Zapier relay in front
  // of Bask) don't forward a timestamp at all — the handler defaults this to
  // the time the webhook was received rather than requiring the caller to
  // manufacture one.
  occurredAt: z.string().datetime().optional(),
});
export type BaskQuestionnaireWebhookRequest = z.infer<typeof baskQuestionnaireWebhookRequestSchema>;

// ── Bask payment-failed webhook ────────────────────────────────────────────────

export const baskPaymentFailedWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  transactionId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  failureDate: z.string().datetime(),
  paymentMethodType: z.string().optional(),
  cardBrand: z.string().optional(),
  cardLast4: z.string().length(4).optional(),
  transactionResponse: z.string().optional(),
  sourceStatus: z.string().optional(),
  testMode: z.boolean().optional(),
});
export type BaskPaymentFailedWebhookRequest = z.infer<typeof baskPaymentFailedWebhookRequestSchema>;

// ── Bask prescription-written webhook ──────────────────────────────────────────
//
// SPECULATIVE — designed from Bask's raw trigger field labels (Data Patient
// Id, Data Prescription Id, ...), not yet verified against a real Zap "Data
// in" test payload the way ghl-lead and bask-order were. Field names here
// follow the same flat-camelCase convention the other Zaps were corrected
// to use; confirm against the real Zap POST body once it's built and adjust
// if Bask's actual field names differ, same lesson as bask-order's orderId.

export const baskPrescriptionWrittenWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1), // Bask's "Data Patient Id"
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  prescriptionId: z.string().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type BaskPrescriptionWrittenWebhookRequest = z.infer<typeof baskPrescriptionWrittenWebhookRequestSchema>;

// ── Bask order-shipped webhook ─────────────────────────────────────────────────
//
// SPECULATIVE, same caveat as above. Bask's real payload also carries nested
// products/shipments arrays (drug name, dosage strength, pharmacy, etc.) —
// deliberately not modeled here since Sarah's shipped notice only needs the
// tracking number, not per-item clinical detail.

export const baskOrderShippedWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1), // Bask's "Data Patient Id"
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  orderNumber: z.string().min(1).optional(),
  trackingNumber: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
});
export type BaskOrderShippedWebhookRequest = z.infer<typeof baskOrderShippedWebhookRequestSchema>;
