/**
 * Outbound SMS provider abstraction. No implementation is registered yet —
 * getSmsProvider() throws until one is wired up (see SMS_PROVIDER env var).
 * Everything that calls this is written as if a real provider already
 * existed, so plugging one in later is a one-file change here, not a
 * rewrite of the follow-up pipeline that calls it.
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

export function getSmsProvider(): SmsProvider {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) {
    throw new SmsProviderNotConfiguredError();
  }
  // No provider implementations exist yet. When one is chosen, add a case
  // here (e.g. "sendblue") returning a real SmsProvider implementation.
  throw new SmsProviderNotConfiguredError();
}
