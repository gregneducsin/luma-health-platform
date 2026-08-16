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

/**
 * The very first outbound message to a lead who abandoned the Bask
 * questionnaire — fired 10 minutes after Bask's `abandoned` webhook event,
 * 24/7, no monitored-hours window. Fixed template, not AI-drafted, same
 * reasoning as the follow-up nudges above. Mentions the $20-off offer
 * directly but deliberately does not include a link — if the customer
 * responds with interest, the normal Lucy conversation loop (runLucyTurn)
 * takes over and mints the real link via action=send_form.
 */
export function renderAbandonedCartOpener(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, this is Lucy with Luma Health. I noticed you started your online visit but didn't get a chance to finish it. Complete your enrollment now and get $20 off your first month. Want me to send the link to get started?`;
}
