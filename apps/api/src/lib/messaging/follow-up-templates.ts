/**
 * Fixed, pre-approved follow-up nudges for a lead who clicked the intake
 * link but hasn't completed the Bask questionnaire yet. These are sent
 * automatically by the follow-up sweep, not drafted per-send by Claude —
 * proactive outbound check-ins don't have an inbound message to react to,
 * so there's nothing for the guardrail loop to validate against; the fixed
 * approved text is the guardrail here.
 *
 * Sequence: provider_check_in fires 2 hours after the click (if still
 * incomplete). If that send succeeds, intake_questions_check_in is
 * scheduled 1 hour after — relative to when the first one actually sent,
 * not a fixed offset from the click, so the "an hour later" promise holds
 * even if the sweep runs a few minutes late.
 */

export type FollowUpMessageStep = "provider_check_in" | "intake_questions_check_in";

const TEMPLATES: Record<FollowUpMessageStep, (firstName: string) => string> = {
  provider_check_in: (firstName) =>
    `Hey ${firstName}, this is Lucy with Luma Health. Should I go ahead and let the doctors know to look out for your completed questionnaire?`,
  intake_questions_check_in: (firstName) => `Hey ${firstName}, just checking in. Do you have any questions about the intake form?`,
};

export function renderFollowUpMessage(step: FollowUpMessageStep, firstName: string): string {
  return TEMPLATES[step](firstName.trim() || "there");
}
