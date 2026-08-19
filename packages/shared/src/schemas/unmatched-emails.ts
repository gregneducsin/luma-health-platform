import { z } from "zod";

export const unmatchedEmailItemSchema = z.object({
  id: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  messageId: z.string().nullable(),
  aiIntent: z.enum(["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"]).nullable(),
  aiSummary: z.string().nullable(),
  suggestedMatchCustomerId: z.string().nullable(),
  suggestedMatchConfidence: z.enum(["high", "medium", "low"]).nullable(),
  suggestedReply: z.string().nullable(),
  status: z.enum(["needs_review", "replied", "dismissed"]),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UnmatchedEmailItem = z.infer<typeof unmatchedEmailItemSchema>;

export const unmatchedEmailsListResponseSchema = z.object({
  items: z.array(unmatchedEmailItemSchema),
});
export type UnmatchedEmailsListResponse = z.infer<typeof unmatchedEmailsListResponseSchema>;

export const sendUnmatchedEmailReplyRequestSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type SendUnmatchedEmailReplyRequest = z.infer<typeof sendUnmatchedEmailReplyRequestSchema>;

export const sendUnmatchedEmailReplyResponseSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_found", "send_failed"]).optional(),
});
export type SendUnmatchedEmailReplyResponse = z.infer<typeof sendUnmatchedEmailReplyResponseSchema>;
