import { describe, expect, it, afterEach, vi } from "vitest";
import { getSmsProvider, SmsProviderNotConfiguredError } from "./sms-provider.js";

const notifySlackMock = vi.fn();
vi.mock("./slack.js", () => ({ notifySmsSlack: (...args: unknown[]) => notifySlackMock(...args) }));

describe("getSmsProvider", () => {
  const originalProvider = process.env.SMS_PROVIDER;
  const originalApiKey = process.env.IBLUSEND_API_KEY;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = originalProvider;
    if (originalApiKey === undefined) delete process.env.IBLUSEND_API_KEY;
    else process.env.IBLUSEND_API_KEY = originalApiKey;
    vi.unstubAllGlobals();
  });

  it("throws SmsProviderNotConfiguredError when SMS_PROVIDER is unset", () => {
    delete process.env.SMS_PROVIDER;
    expect(() => getSmsProvider()).toThrow(SmsProviderNotConfiguredError);
  });

  it("throws SmsProviderNotConfiguredError for an unrecognized provider name", () => {
    process.env.SMS_PROVIDER = "sendblue";
    expect(() => getSmsProvider()).toThrow(SmsProviderNotConfiguredError);
  });

  it("throws a configuration error when SMS_PROVIDER=iblusend but IBLUSEND_API_KEY is unset", () => {
    process.env.SMS_PROVIDER = "iblusend";
    delete process.env.IBLUSEND_API_KEY;
    expect(() => getSmsProvider()).toThrow(/IBLUSEND_API_KEY/);
  });

  it("alerts Slack when SMS_PROVIDER is unset, not just a warn log — this is exactly the failure mode that went unnoticed in production", () => {
    notifySlackMock.mockClear();
    delete process.env.SMS_PROVIDER;
    expect(() => getSmsProvider()).toThrow();
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/SMS send failed/);
  });

  it("alerts Slack when SMS_PROVIDER=iblusend but IBLUSEND_API_KEY is unset", () => {
    notifySlackMock.mockClear();
    process.env.SMS_PROVIDER = "iblusend";
    delete process.env.IBLUSEND_API_KEY;
    expect(() => getSmsProvider()).toThrow();
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/SMS send failed/);
  });

  it("returns an iBluSend provider when both SMS_PROVIDER and IBLUSEND_API_KEY are set", () => {
    process.env.SMS_PROVIDER = "iblusend";
    process.env.IBLUSEND_API_KEY = "iblu_test_abc123";
    expect(() => getSmsProvider()).not.toThrow();
  });

  describe("IbluSendProvider.sendMessage", () => {
    it("sends a message and returns the provider message id", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, message_id: "sim_abc123" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await getSmsProvider().sendMessage("+15551234567", "Hello there");

      expect(result).toEqual({ providerMessageId: "sim_abc123" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.iblusend.com/functions/v1/send-message",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer iblu_test_abc123" }),
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ phone_number: "+15551234567", content: "Hello there" });
    });

    it("throws when iBluSend responds with a non-2xx status", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '{"error":"rate_limited"}' }),
      );

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/429/);
    });

    it("throws when the response is missing message_id", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/message_id/);
    });

    it("alerts Slack on a send failure, then still rejects with the original error", async () => {
      notifySlackMock.mockClear();
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '{"error":"rate_limited"}' }),
      );

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/429/);
      expect(notifySlackMock).toHaveBeenCalledTimes(1);
      expect(notifySlackMock.mock.calls[0][0]).toMatch(/SMS send failed/);
    });

    it("includes the parsed error/detail (e.g. a daily rate-limit reason) in the Slack alert, not just the phone number", async () => {
      notifySlackMock.mockClear();
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      const body = JSON.stringify({
        error: "Daily new-contact outreach limit reached",
        error_code: "device_daily_cap_exceeded",
        limit: 50,
        detail: "The assigned line has reached its cold-contact limit. Its sender identity will be preserved. Replied conversations can continue.",
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => body }));

      await expect(getSmsProvider().sendMessage("+14787769678", "Hello there")).rejects.toThrow(
        /Daily new-contact outreach limit reached — The assigned line has reached its cold-contact limit/,
      );
      expect(notifySlackMock).toHaveBeenCalledTimes(1);
      expect(notifySlackMock.mock.calls[0][0]).toBe(
        "SMS send failed — +14787769678 — iBluSend send failed: 429 Daily new-contact outreach limit reached — The assigned line has reached its cold-contact limit. Its sender identity will be preserved. Replied conversations can continue.",
      );
    });

    it("falls back to the raw response body when it isn't the expected JSON error shape", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" }));

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/500 Internal Server Error/);
    });
  });
});
