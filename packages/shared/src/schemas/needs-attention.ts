import { z } from "zod";

export const needsAttentionChannelSchema = z.enum(["sms", "email"]);
export type NeedsAttentionChannel = z.infer<typeof needsAttentionChannelSchema>;

export const needsAttentionPersonaSchema = z.enum(["lucy", "sarah"]);
export type NeedsAttentionPersona = z.infer<typeof needsAttentionPersonaSchema>;

export const needsAttentionItemSchema = z.object({
  conversationId: z.string(),
  channel: needsAttentionChannelSchema,
  persona: needsAttentionPersonaSchema,
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  lastMessagePreview: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
});
export type NeedsAttentionItem = z.infer<typeof needsAttentionItemSchema>;

export const needsAttentionListResponseSchema = z.object({
  items: z.array(needsAttentionItemSchema),
});
export type NeedsAttentionListResponse = z.infer<typeof needsAttentionListResponseSchema>;

export const needsAttentionMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type NeedsAttentionMessage = z.infer<typeof needsAttentionMessageSchema>;

export const needsAttentionMessagesResponseSchema = z.object({
  messages: z.array(needsAttentionMessageSchema),
});
export type NeedsAttentionMessagesResponse = z.infer<typeof needsAttentionMessagesResponseSchema>;
