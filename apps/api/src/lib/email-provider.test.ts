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

// Outbound sending is currently hard-paused in code (OUTBOUND_EMAIL_SENDING_PAUSED
// in email-provider.ts) — every call throws EmailProviderNotConfiguredError
// regardless of configuration, so the provider-selection/persona-name tests below
// are temporarily unreachable and have been replaced by a single test asserting
// the pause. Restore the fuller test matrix (provider validation, credential
// checks, persona name defaults/overrides) when the pause is lifted.
describe("getEmailProvider", () => {
  it("throws EmailProviderNotConfiguredError for every persona/config while outbound sending is paused", () => {
    expect(() => getEmailProvider("lucy")).toThrow(EmailProviderNotConfiguredError);

    process.env.EMAIL_PROVIDER = "google_workspace";
    process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
    process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
    expect(() => getEmailProvider("lucy")).toThrow(EmailProviderNotConfiguredError);
    expect(() => getEmailProvider("sarah")).toThrow(EmailProviderNotConfiguredError);
  });
});
