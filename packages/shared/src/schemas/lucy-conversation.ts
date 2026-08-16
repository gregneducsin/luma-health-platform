import { z } from "zod";

const slotValueSchema = z.enum(["yes", "no"]).nullable();

export const lucyTurnRequestSchema = z.object({
  customerId: z.string().uuid(),
  messages: z
    .array(
      z.object({
        direction: z.enum(["inbound", "outbound"]),
        body: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(40),
  currentSlots: z.object({
    selectedProduct: z.enum(["semaglutide", "tirzepatide"]).nullable(),
    currentlyTaking: slotValueSchema,
    wantsProcessExplanation: slotValueSchema,
    hasTimeForIntake: slotValueSchema,
    wantsPlanInclusions: slotValueSchema,
    readyForForm: slotValueSchema,
  }),
  lastQuestion: z.string().max(300).nullable(),
  pendingTopic: z.string().max(100).nullable(),
  lastDraft: z.string().max(400).nullable(),
  objectionStage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  linkProvided: z.boolean(),
  promoOffered: z.boolean(),
});
export type LucyTurnRequest = z.infer<typeof lucyTurnRequestSchema>;

export const lucyTurnResponseSchema = z.object({
  action: z.string(),
  reply: z.string().nullable(),
  nextQuestion: z.string().nullable(),
  link: z.string().nullable(),
  objectionStage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  linkProvided: z.boolean(),
  promoOffered: z.boolean(),
  requiresStaff: z.boolean(),
  knowledgeTopicsUsed: z.array(z.string()),
  validatedSlotUpdates: z.record(z.string(), z.unknown()),
});
export type LucyTurnResponse = z.infer<typeof lucyTurnResponseSchema>;
