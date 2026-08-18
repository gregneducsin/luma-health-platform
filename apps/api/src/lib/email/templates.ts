/**
 * Fixed, pre-approved email templates for automated trigger sends — same
 * "fixed text, not AI-drafted" reasoning as follow-up-templates.ts and
 * support/templates.ts: a proactive outbound notice has no inbound message
 * to react to, so there's nothing for the guardrail loop to validate
 * against. Copy mirrors the SMS wording for the same event so a customer
 * getting both channels sees a consistent voice.
 *
 * Every template is wrapped with wrapEmailHtml, which adds the CAN-SPAM
 * required footer (physical address + one-click unsubscribe link) — every
 * automated send carries it, transactional or not, so there's no
 * per-template special-casing to get wrong.
 */

const PHYSICAL_ADDRESS_FALLBACK = "Luma Health";

function physicalAddress(): string {
  return process.env.LUMA_PHYSICAL_ADDRESS ?? PHYSICAL_ADDRESS_FALLBACK;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
}

/**
 * Crude but dependency-free HTML→text, used two ways: turning a parsed
 * inbound email's HTML-only body into something the guardrail/AI turn can
 * read (email-inbound.service.ts), and turning an outbound template's
 * rendered HTML into the plain-text record stored as conversation history
 * (send-trigger-email.ts) — that history is what a later inbound turn's
 * toEmailPreviewBody/toSupportEmailPreviewBody feeds back to the model, so
 * it must never contain raw markup.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wrapEmailHtml(bodyHtml: string, unsubscribeUrl: string): string {
  return (
    `<div style="font-family: -apple-system, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 600px;">` +
    `${bodyHtml}` +
    `<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;" />` +
    `<p style="font-size: 12px; color: #888;">${physicalAddress()}<br/>` +
    `<a href="${unsubscribeUrl}" style="color: #888;">Unsubscribe</a> from future emails.</p>` +
    `</div>`
  );
}

export function renderOrderReceivedEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const body =
    `<p>Hello ${name}, this is Sarah on the doctor support side. It looks like we received your order and the doctor is reviewing it now.</p>` +
    `<p>If they have any further questions they will reach out in the patient portal, <a href="https://go.mylumahealth.com/login">https://go.mylumahealth.com/login</a></p>` +
    `<p>We will update you once the prescription is written and sent to the pharmacy.</p>`;
  return { subject: "We received your order", html: wrapEmailHtml(body, unsubscribeUrl) };
}

export function renderOrderShippedEmail(firstName: string, trackingNumber: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const body = `<p>Hi ${name}, your order has shipped. Your tracking number is <strong>${trackingNumber}</strong>.</p>`;
  return { subject: "Your order has shipped", html: wrapEmailHtml(body, unsubscribeUrl) };
}

export function renderReviewRequestEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const body = `<p>Hi ${name}, this is Sarah with Luma Health. Now that you've had a chance to receive your medication, how has your experience with us been so far?</p>`;
  return { subject: "How has your experience been?", html: wrapEmailHtml(body, unsubscribeUrl) };
}

export function renderAbandonedCartOpenerEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const body =
    `<p>Hi ${name}, this is Lucy with Luma Health. I noticed you started your online visit but didn't get a chance to finish it.</p>` +
    `<p>Complete your enrollment now and get $20 off your first month. Want me to send the link to get started?</p>`;
  return { subject: "You didn't finish your enrollment — $20 off if you do", html: wrapEmailHtml(body, unsubscribeUrl) };
}

export function renderCurrentlyTakingCheckinEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const body = `<p>Hi ${name}, this is Lucy with Luma Health. Quick question — are you currently taking semaglutide or tirzepatide?</p>`;
  return { subject: "Quick question for you", html: wrapEmailHtml(body, unsubscribeUrl) };
}

export function renderReengagementCheckinEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const body = `<p>Hi ${name}, this is Lucy with Luma Health. Still thinking it over? What's the biggest thing holding you back from getting started?</p>`;
  return { subject: "Still thinking it over?", html: wrapEmailHtml(body, unsubscribeUrl) };
}

/** Plain-reply wrapper for AI-drafted turn replies (Lucy/Sarah email dispatch) — same wrapper, no fixed copy since the text itself is the guardrail-validated draft. */
export function renderConversationReplyEmail(bodyText: string, unsubscribeUrl: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return wrapEmailHtml(paragraphs, unsubscribeUrl);
}
