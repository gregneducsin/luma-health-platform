import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getEmailProvider, EmailProviderNotConfiguredError } from "./email-provider.js";

const ENV_KEYS = [
  "EMAIL_PROVIDER",
  "GOOGLE_WORKSPACE_SMTP_USER",
  "GOOGLE_WORKSPACE_SMTP_APP_PASSWORD",
  "GOOGLE_WORKSPACE_FROM_EMAIL",
  "GOOGLE_WORKSPACE_LUCY_FROM_NAME",
  "GOOGLE_WORKSPACE_SARAH_FROM_NAME",
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
