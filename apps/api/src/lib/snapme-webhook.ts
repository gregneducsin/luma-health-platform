import { logger } from "./logger.js";
import { notifySmsSlack } from "./slack.js";

/**
 * Outbound notification to snapme.link's ad-attribution resolver — fired the
 * moment an inbound text mentions a Facebook/Meta "text us directly" ad's
 * promo/priority code, so their system can attribute the response back to
 * whichever ad/link sent them here. Deliberately fires on the raw signal
 * itself (phone + the actual code value, nothing else) rather than waiting
 * for a lead to actually get created: a customer can text the code and then
 * go quiet before ever giving a name/email (see
 * unmatched-inbound-sms.service.ts's maybeCreateLead docstring for a real
 * production case — Siba — where exactly that happened), and attribution
 * still matters even then.
 *
 * Fire-and-forget: a failure here must never affect the rest of the inbound
 * SMS pipeline, so this only ever logs + alerts, never throws to its caller.
 */
export async function notifySnapmePriorityCodeReceived(phone: string, code: string): Promise<void> {
  const url = process.env.SNAPME_DTC_RESOLVER_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      void notifySmsSlack(`snapme.link priority-code notify failed — ${phone} — ${res.status} ${text}`);
      return;
    }
    // Only success signal this call has — there's no callback from
    // snapme.link, so this is what you grep Railway's logs for to confirm a
    // notification actually went out (vs. never having fired at all).
    logger.info({ phone, code }, "notified snapme.link of a received priority/promo code");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void notifySmsSlack(`snapme.link priority-code notify failed — ${phone} — ${reason}`);
  }
}

/**
 * Outbound notification to snapme.link's funnel "reply" endpoint — fired
 * once per thread, the first time the customer replies to whatever message
 * we sent back after they texted in a promo/priority code. Distinct from
 * notifySnapmePriorityCodeReceived above (a different signal, a different
 * URL): that one fires the instant the code itself arrives; this one fires
 * on their next reply after that, carrying the same code alongside the
 * actual reply text, so snapme.link can see the funnel progressing past the
 * initial code drop. See unmatched-inbound-sms.service.ts for the
 * once-per-thread gating (dtcReplyNotifiedAt).
 *
 * Fire-and-forget: a failure here must never affect the rest of the inbound
 * SMS pipeline, so this only ever logs + alerts, never throws to its caller.
 */
export async function notifySnapmeDtcReplyReceived(phone: string, code: string, response: string): Promise<void> {
  const url = process.env.SNAPME_DTC_REPLY_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code, response }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      void notifySmsSlack(`snapme.link reply notify failed — ${phone} — ${res.status} ${text}`);
      return;
    }
    logger.info({ phone, code }, "notified snapme.link of the customer's reply to the priority/promo code funnel");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void notifySmsSlack(`snapme.link reply notify failed — ${phone} — ${reason}`);
  }
}
