import { z } from "zod";
import { normalizePhone } from "./phone.js";

const intentSchema = z.enum([
  "new_lead_interest",
  "existing_customer_support",
  "spam_or_irrelevant",
  "other",
]);
const matchConfidenceSchema = z.enum(["high", "medium", "low"]);

const summarySchema = z.string().trim().min(1).max(1_000);
const suggestedReplySchema = z.string().trim().min(1).max(2_000).nullable();
const senderNameSchema = z.string().trim().min(1).max(200).nullable();
const senderEmailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((value) => value.toLowerCase())
  .nullable();
const senderPhoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform(normalizePhone)
  .refine((value) => /^\+1\d{10}$/.test(value), "Invalid phone number")
  .nullable();
const matchCandidateIndexSchema = z.number().int().nonnegative().nullable();

const unmatchedSmsClassificationSchema = z
  .object({
    intent: intentSchema,
    summary: summarySchema,
    suggestedReply: suggestedReplySchema,
    senderName: senderNameSchema,
    senderEmail: senderEmailSchema,
    matchCandidateIndex: matchCandidateIndexSchema,
    matchConfidence: matchConfidenceSchema.nullable(),
    needsHumanReview: z.boolean(),
    confirmsExistingCustomer: z.boolean(),
    productCategoryMentioned: z.enum([
      "weight_loss_medication",
      "other_business_line",
      "none",
    ]),
  })
  .strict();

const unmatchedEmailClassificationSchema = z
  .object({
    intent: intentSchema,
    summary: summarySchema,
    suggestedReply: suggestedReplySchema,
    senderName: senderNameSchema,
    senderPhone: senderPhoneSchema,
    matchCandidateIndex: matchCandidateIndexSchema,
    matchConfidence: matchConfidenceSchema.nullable(),
    needsHumanReview: z.boolean(),
  })
  .strict();

export type UnmatchedSmsClassification = z.infer<
  typeof unmatchedSmsClassificationSchema
>;
export type UnmatchedEmailClassification = z.infer<
  typeof unmatchedEmailClassificationSchema
>;

function candidateIndexIsValid(
  index: number | null,
  confidence: "high" | "medium" | "low" | null,
  candidateCount: number,
): boolean {
  if (index === null) return confidence === null;
  return confidence !== null && index < candidateCount;
}

export function parseUnmatchedSmsClassification(
  input: unknown,
  candidateCount: number,
): UnmatchedSmsClassification | null {
  const parsed = unmatchedSmsClassificationSchema.safeParse(input);
  if (
    !parsed.success ||
    !candidateIndexIsValid(
      parsed.data.matchCandidateIndex,
      parsed.data.matchConfidence,
      candidateCount,
    )
  )
    return null;
  return parsed.data;
}

export function parseUnmatchedEmailClassification(
  input: unknown,
  candidateCount: number,
): UnmatchedEmailClassification | null {
  const parsed = unmatchedEmailClassificationSchema.safeParse(input);
  if (
    !parsed.success ||
    !candidateIndexIsValid(
      parsed.data.matchCandidateIndex,
      parsed.data.matchConfidence,
      candidateCount,
    )
  )
    return null;
  return parsed.data;
}
