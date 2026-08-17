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
 * iBluSend — iMessage-first send with SMS fallback. send_mode "instant" is
 * used unconditionally here (not the default "drip" paced queue): every
 * caller of SmsProvider.sendMessage is a conversational reply to an inbound
 * message Lucy/Sarah just processed, not cold outreach, so it should go out
 * now, not be paced over the next ~10 minutes. Instant sends are
 * rate-limited by iBluSend itself (10/min, 75/day per key) — a caller
 * exceeding that gets a thrown error, same as any other send failure; the
 * dispatch pipeline (sendAndLog) already logs-and-continues rather than
 * blocking on a transport failure.
 */
class IbluSendProvider implements SmsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.iblusend.com/functions/v1",
  ) {}

  async sendMessage(to: string, body: string): Promise<SmsSendResult> {
    const res = await fetch(`${this.baseUrl}/agent-api/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, message: body, send_mode: "instant" }),
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
