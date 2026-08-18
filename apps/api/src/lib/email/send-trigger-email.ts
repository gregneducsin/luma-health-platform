import { getEmailProvider, type EmailPersona } from "../email-provider.js";
import { htmlToPlainText, type RenderedEmail } from "./templates.js";
import { buildUnsubscribeUrl } from "./unsubscribe.js";
import { isCustomerDnd } from "../../services/dnd.service.js";
import { logger } from "../logger.js";

type AppendEmailMessageFn = (
  conversationId: string,
  direction: "inbound" | "outbound",
  subject: string,
  body: string,
  opts?: { sentiment?: "positive" | "neutral" | "negative" | null; messageId?: string | null; inReplyTo?: string | null },
) => Promise<unknown>;

/**
 * Shared fail-soft send+log for the fixed, pre-approved trigger emails
 * (order received/shipped, review request, abandoned-cart opener, lead
 * check-in) — same DND-gated, log-and-continue-on-failure shape as every
 * SMS trigger send in this codebase, and as lucy-email-dispatch.service.ts
 * /sarah-email-dispatch.service.ts's own sendAndLog for AI-drafted replies.
 * `appendMessage` is either appendEmailMessage or appendSupportEmailMessage
 * — both share this exact signature, so one helper covers both channels'
 * fixed-template sends instead of duplicating this logic five times.
 */
export async function sendTriggerEmail(params: {
  persona: EmailPersona;
  personId: string;
  conversationId: string;
  email: string;
  /** Renders the template given this customer's unsubscribe URL — called (and its own failures caught) inside this function, not by the caller, so a config error (e.g. INTAKE_LINK_BASE_URL unset) fails soft like every other send failure instead of throwing out of the trigger pipeline that called this. */
  render: (unsubscribeUrl: string) => RenderedEmail;
  appendMessage: AppendEmailMessageFn;
  logLabel: string;
}): Promise<void> {
  const { persona, personId, conversationId, email, render, appendMessage, logLabel } = params;

  if (await isCustomerDnd(personId)) {
    logger.warn({ personId, conversationId }, `${logLabel} email not sent: customer is do-not-disturb`);
    return;
  }

  let rendered: RenderedEmail;
  try {
    rendered = render(buildUnsubscribeUrl(personId));
  } catch (err) {
    logger.warn({ personId, conversationId, reason: err instanceof Error ? err.message : String(err) }, `${logLabel} email not sent: failed to render`);
    return;
  }

  const plainBody = htmlToPlainText(rendered.html);
  let messageId: string | null = null;
  try {
    const { provider, fromName } = getEmailProvider(persona);
    const result = await provider.sendEmail(email, rendered.subject, rendered.html, { fromName });
    messageId = result.messageId;
  } catch (err) {
    logger.warn({ personId, conversationId, reason: err instanceof Error ? err.message : String(err) }, `${logLabel} email send failed`);
  }
  await appendMessage(conversationId, "outbound", rendered.subject, plainBody, { messageId });
}
