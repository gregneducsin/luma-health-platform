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
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void notifySmsSlack(`snapme.link priority-code notify failed — ${phone} — ${reason}`);
  }
}
