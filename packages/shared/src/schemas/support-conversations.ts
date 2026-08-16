import { z } from "zod";

export const supportConversationSummarySchema = z.object({
  id: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.enum(["active", "closed"]),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  needsAttention: z.boolean(),
});
export type SupportConversationSummary = z.infer<typeof supportConversationSummarySchema>;

export const supportConversationMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  body: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  createdAt: z.string(),
});
export type SupportConversationMessageDto = z.infer<typeof supportConversationMessageSchema>;

export const supportConversationDetailSchema = z.object({
  conversation: z.object({
    id: z.string(),
    personId: z.string(),
    status: z.enum(["active", "closed"]),
    prescriptionWritten: z.boolean(),
    orderShipped: z.boolean(),
    trackingNumber: z.string().nullable(),
    reviewRequested: z.boolean(),
    reviewSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
    needsAttention: z.boolean(),
  }),
  customer: z.object({ firstName: z.string(), lastName: z.string(), phone: z.string().nullable() }),
  messages: z.array(supportConversationMessageSchema),
});
export type SupportConversationDetail = z.infer<typeof supportConversationDetailSchema>;
