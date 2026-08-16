import { describe, expect, it, afterEach } from "vitest";
import { getSmsProvider, SmsProviderNotConfiguredError } from "./sms-provider.js";

describe("getSmsProvider", () => {
  const originalEnv = process.env.SMS_PROVIDER;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = originalEnv;
  });

  it("throws SmsProviderNotConfiguredError when SMS_PROVIDER is unset", () => {
    delete process.env.SMS_PROVIDER;
    expect(() => getSmsProvider()).toThrow(SmsProviderNotConfiguredError);
  });

  it("still throws when SMS_PROVIDER is set — no implementation is registered yet", () => {
    process.env.SMS_PROVIDER = "sendblue";
    expect(() => getSmsProvider()).toThrow(SmsProviderNotConfiguredError);
  });
});
