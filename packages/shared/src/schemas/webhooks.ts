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
  occurredAt: z.string().datetime(),
});
export type GhlLeadWebhookRequest = z.infer<typeof ghlLeadWebhookRequestSchema>;

// ── Bask order webhook ────────────────────────────────────────────────────────

export const baskOrderWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  orderNumber: z.string().min(1),
  productName: z.string().min(1),
  amountPaid: z.string().regex(/^\d+(\.\d{1,2})?$/),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ecommerceOrderId: z.string().min(1).optional(),
  occurredAt: z.string().datetime(),
});
export type BaskOrderWebhookRequest = z.infer<typeof baskOrderWebhookRequestSchema>;

// ── Bask questionnaire webhook ─────────────────────────────────────────────────

export const baskQuestionnaireWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  questionnaireId: z.string().min(1),
  status: z.enum(["started", "abandoned", "submitted"]),
  occurredAt: z.string().datetime(),
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
