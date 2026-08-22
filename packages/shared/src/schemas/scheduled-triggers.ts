import { z } from "zod";

export const upcomingTriggerSchema = z.object({
  kind: z.enum([
    "follow_up",
    "abandoned_cart_sms",
    "lead_checkin_sms",
    "objection_reengagement_sms",
    "abandoned_cart_email",
    "meta_lead_email",
    "review_request_sms",
  ]),
  label: z.string(),
  dueAt: z.string(),
  status: z.enum(["pending", "processing"]),
});
export type UpcomingTrigger = z.infer<typeof upcomingTriggerSchema>;

export const upcomingTriggerResponseSchema = z.object({
  trigger: upcomingTriggerSchema.nullable(),
});
export type UpcomingTriggerResponse = z.infer<typeof upcomingTriggerResponseSchema>;
