import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getEmailProvider, EmailProviderNotConfiguredError } from "./email-provider.js";

const ENV_KEYS = [
  "EMAIL_PROVIDER",
  "GOOGLE_WORKSPACE_SMTP_USER",
  "GOOGLE_WORKSPACE_SMTP_APP_PASSWORD",
  "GOOGLE_WORKSPACE_FROM_EMAIL",
  "GOOGLE_WORKSPACE_LUCY_FROM_NAME",
  "GOOGLE_WORKSPACE_SARAH_FROM_NAME",
  "GOOGLE_GMAIL_FROM_EMAIL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_REFRESH_TOKEN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getEmailProvider", () => {
  it("throws EmailProviderNotConfiguredError when EMAIL_PROVIDER is unset", () => {
    expect(() => getEmailProvider("lucy")).toThrow(EmailProviderNotConfiguredError);
  });

  it("throws EmailProviderNotConfiguredError for an unknown provider name", () => {
    process.env.EMAIL_PROVIDER = "sendgrid";
    expect(() => getEmailProvider("lucy")).toThrow(EmailProviderNotConfiguredError);
  });

  describe("google_workspace (SMTP)", () => {
    it("throws a clear error when the mailbox credentials are missing", () => {
      process.env.EMAIL_PROVIDER = "google_workspace";
      expect(() => getEmailProvider("lucy")).toThrow(/GOOGLE_WORKSPACE_SMTP_USER/);
    });

    it("defaults to persona-specific display names", () => {
      process.env.EMAIL_PROVIDER = "google_workspace";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
      process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";

      expect(getEmailProvider("lucy").fromName).toBe("Lucy at Luma Health");
      expect(getEmailProvider("sarah").fromName).toBe("Sarah at Luma Health");
    });

    it("uses a per-persona GOOGLE_WORKSPACE_*_FROM_NAME override when set", () => {
      process.env.EMAIL_PROVIDER = "google_workspace";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
      process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
      process.env.GOOGLE_WORKSPACE_LUCY_FROM_NAME = "Luma Sales";

      expect(getEmailProvider("lucy").fromName).toBe("Luma Sales");
      expect(getEmailProvider("sarah").fromName).toBe("Sarah at Luma Health");
    });
  });

  describe("gmail_api (Gmail API over HTTPS)", () => {
    it("throws a clear error listing every missing OAuth var", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      expect(() => getEmailProvider("lucy")).toThrow(/GOOGLE_GMAIL_FROM_EMAIL or GOOGLE_WORKSPACE_SMTP_USER.*GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*GOOGLE_REDIRECT_URI.*GOOGLE_REFRESH_TOKEN/s);
    });

    it("throws when only the from-email is missing, with the OAuth vars set", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      process.env.GOOGLE_CLIENT_ID = "client-id";
      process.env.GOOGLE_CLIENT_SECRET = "client-secret";
      process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";
      expect(() => getEmailProvider("lucy")).toThrow(/GOOGLE_GMAIL_FROM_EMAIL or GOOGLE_WORKSPACE_SMTP_USER/);
    });

    it("falls back to GOOGLE_WORKSPACE_SMTP_USER for the from-email when GOOGLE_GMAIL_FROM_EMAIL is unset", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "lucym@start.mylumahealth.com";
      process.env.GOOGLE_CLIENT_ID = "client-id";
      process.env.GOOGLE_CLIENT_SECRET = "client-secret";
      process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";

      expect(() => getEmailProvider("lucy")).not.toThrow();
    });

    it("uses GOOGLE_GMAIL_FROM_EMAIL over GOOGLE_WORKSPACE_SMTP_USER when both are set, and persona display names still apply", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      process.env.GOOGLE_GMAIL_FROM_EMAIL = "sarah@start.mylumahealth.com";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "lucym@start.mylumahealth.com";
      process.env.GOOGLE_CLIENT_ID = "client-id";
      process.env.GOOGLE_CLIENT_SECRET = "client-secret";
      process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";

      expect(getEmailProvider("sarah").fromName).toBe("Sarah at Luma Health");
    });
  });
});
