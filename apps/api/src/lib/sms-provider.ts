/**
 * Outbound SMS provider abstraction. getSmsProvider() throws until one is
 * wired up (see SMS_PROVIDER env var). Everything that calls this is
 * written as if a real provider already existed, so plugging one in is a
 * one-file change here, not a rewrite of the dispatch pipeline that calls
 * it.
 */

export interface SmsSendResult {
  readonly providerMessageId: string;
}

export interface SmsProvider {
  sendMessage(to: string, body: string): Promise<SmsSendResult>;
}

export class SmsProviderNotConfiguredError extends Error {
  constructor() {
    super("No SMS provider is configured (SMS_PROVIDER is unset).");
    this.name = "SmsProviderNotConfiguredError";
  }
}

/**
 * iBluSend — iMessage-first send with SMS fallback, via the dedicated AI
 * Agent API (/agent-api/messages), not the generic /send-message endpoint —
 * iBluSend's own docs recommend the Agent API specifically for AI-bot
 * traffic ("safer than pointing an agent at raw iMessage"), and it's the
 * only one of the two with the pacing behavior send_mode controls.
 *
 * send_mode "instant" is used unconditionally here (not the default "drip"
 * paced queue): every caller of SmsProvider.sendMessage is a conversational
 * reply to an inbound message Lucy/Sarah just processed, not cold outreach,
 * so it should go out now, not be paced over the next ~10 minutes.
 *
 * Field names (phone_number/content, not to/message) and the path itself
 * (agent-api/messages, no /v1/) were corrected 2026-08-21 against iBluSend's
 * current docs — the previous values didn't match any endpoint shown there
 * and would have failed against the real API. The exact instant-send rate
 * limit (previously noted here as 10/min, 75/day) isn't confirmed against
 * the current docs, which only publish the general per-plan API rate limit
 * (Starter 60/min, Pro 150/min, Agency 500/min) and defer pacing specifics
 * to a separate "AI Agent Guide" not yet reviewed — a caller exceeding
 * whatever the real limit is gets a thrown error either way, same as any
 * other send failure; the dispatch pipeline (sendAndLog) already
 * logs-and-continues rather than blocking on a transport failure.
 */
class IbluSendProvider implements SmsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.iblusend.com/functions/v1",
  ) {}

  async sendMessage(to: string, body: string): Promise<SmsSendResult> {
    const res = await fetch(`${this.baseUrl}/agent-api/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone_number: to, content: body, send_mode: "instant" }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`iBluSend send failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as { message_id?: string };
    if (!json.message_id) {
      throw new Error("iBluSend send response missing message_id.");
    }
    return { providerMessageId: json.message_id };
  }
}

export function getSmsProvider(): SmsProvider {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) {
    throw new SmsProviderNotConfiguredError();
  }
  if (provider === "iblusend") {
    const apiKey = process.env.IBLUSEND_API_KEY;
    if (!apiKey) {
      throw new Error("SMS_PROVIDER is 'iblusend' but IBLUSEND_API_KEY is not set.");
    }
    return new IbluSendProvider(apiKey);
  }
  throw new SmsProviderNotConfiguredError();
}
