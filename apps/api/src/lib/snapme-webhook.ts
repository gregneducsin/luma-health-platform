import { notifySmsSlack } from "./slack.js";

/**
 * Outbound notification to snapme.link's GHL-style resolver, fired once when
 * a brand-new DTC ("text us directly") lead comes in — so their system can
 * attribute the response back to whichever ad/link sent them here. Built for
 * a GHL webhook action (its own field names are ghl_contact_id/phone/email,
 * lifted straight from GHL's {{contact.*}} template variables), but nothing
 * about receiving a plain JSON POST requires the sender to actually be GHL —
 * we just fill in the same field names from our own data instead.
 *
 * ghl_contact_id is deliberately never sent: a DTC lead is created directly
 * from an inbound text (see unmatched-inbound-sms.service.ts), not from a
 * GHL contact, so there is no real GHL id to give it — the field is only
 * "recommended," not required, per snapme.link's own docs.
 *
 * Fire-and-forget: a failure here must never affect lead creation or the
 * customer's own conversation, so this only ever logs + alerts, never throws
 * to its caller.
 */
export async function notifySnapmeDtcLeadResponded(message: string, phone: string, email: string | null): Promise<void> {
  const url = process.env.SNAPME_DTC_RESOLVER_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, phone, ...(email ? { email } : {}) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      void notifySmsSlack(`snapme.link DTC-lead notify failed — ${phone} — ${res.status} ${text}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void notifySmsSlack(`snapme.link DTC-lead notify failed — ${phone} — ${reason}`);
  }
}
