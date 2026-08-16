/**
 * Fixed, pre-approved messages for Sarah's post-purchase support flow. Every
 * one of these is a status update fired off a real webhook event, not
 * AI-drafted — proactive outbound messages don't have an inbound message to
 * react to, so there's nothing for the guardrail loop to validate against;
 * the fixed approved text is the guardrail here. Same reasoning as Lucy's
 * follow-up-templates.ts.
 */

export function renderOrderReceivedMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return (
    `Hello ${name}, this is Sarah on the doctor support side. It looks like we received your order and the doctor is reviewing it now. ` +
    "If they have any further questions they will reach out in the patient portal, https://go.mylumahealth.com/login\n\n" +
    "We will update you once the prescription is written and sent to the pharmacy."
  );
}

export function renderPrescriptionWrittenMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, good news, the doctor has written your prescription and it's on its way to the pharmacy. We'll let you know as soon as it ships.`;
}

export function renderOrderShippedMessage(firstName: string, trackingNumber: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, your order has shipped. Your tracking number is ${trackingNumber}.`;
}

export function renderReviewRequestMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, this is Sarah with Luma Health. Now that you've had a chance to receive your medication, how has your experience with us been so far?`;
}
