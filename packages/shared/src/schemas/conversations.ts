import { z } from "zod";

export const conversationSummarySchema = z.object({
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
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  body: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  createdAt: z.string(),
});
export type ConversationMessageDto = z.infer<typeof conversationMessageSchema>;

export const conversationDetailSchema = z.object({
  conversation: z.object({
    id: z.string(),
    personId: z.string(),
    status: z.enum(["active", "closed"]),
    selectedProduct: z.string().nullable(),
    objectionStage: z.number(),
    linkProvided: z.boolean(),
    promoOffered: z.boolean(),
    needsAttention: z.boolean(),
  }),
  customer: z.object({ firstName: z.string(), lastName: z.string(), phone: z.string().nullable() }),
  messages: z.array(conversationMessageSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
