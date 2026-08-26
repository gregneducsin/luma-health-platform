import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { stripQuotedReply, parseExtraMailboxes, imapConfigs } from "./email-inbound.service.js";

describe("stripQuotedReply", () => {
  it("returns the whole body when there's no quoted history", () => {
    expect(stripQuotedReply("Sounds good, let's do it.")).toBe("Sounds good, let's do it.");
  });

  it("cuts off at a Gmail-style 'On ... wrote:' quote header", () => {
    const body = "Yes please send the link.\n\nOn Tue, Jan 6, 2026 at 3:14 PM Lucy at Luma Health <lucy@lumahealth.com> wrote:\n> Hi Jamie, want the link?";
    expect(stripQuotedReply(body)).toBe("Yes please send the link.");
  });

  it("cuts off at an Outlook-style 'From:/Sent:' original-message header", () => {
    const body = "No thanks.\n\nFrom: Lucy at Luma Health\nSent: Tuesday, January 6, 2026 3:14 PM\nTo: Jamie\nSubject: Re: enrollment";
    expect(stripQuotedReply(body)).toBe("No thanks.");
  });

  it("cuts off at a run of '> ' quoted lines when no recognized header is present", () => {
    const body = "Still interested, what's the price?\n> previous message text\n> more previous text";
    expect(stripQuotedReply(body)).toBe("Still interested, what's the price?");
  });

  it("trims surrounding whitespace", () => {
    expect(stripQuotedReply("  hello there  \n\n")).toBe("hello there");
  });

  it("cuts off at a quote header even when the display name + address push it past 80 characters", () => {
    // Real-world case that slipped through: a long display name plus a
    // subdomain address ("Sarah at Luma Health <lucym@start.mylumahealth.com>")
    // pushes the "On ... wrote:" header past a too-tight character cap,
    // leaving the whole header line stuck in the visible message.
    const body =
      "okay and then if i wanted to speak to the doctor?\n\n" +
      "On Wed, Aug 19, 2026 at 12:01 AM Sarah at Luma Health <lucym@start.mylumahealth.com> wrote:\n> previous message text";
    expect(stripQuotedReply(body)).toBe("okay and then if i wanted to speak to the doctor?");
  });
});

describe("parseExtraMailboxes", () => {
  it("returns an empty array when unset or blank", () => {
    expect(parseExtraMailboxes(undefined)).toEqual([]);
    expect(parseExtraMailboxes("  ")).toEqual([]);
  });

  it("parses a single user:apppassword entry", () => {
    expect(parseExtraMailboxes("hello@mylumahealth.com:abcdefghijklmnop")).toEqual([
      { host: "imap.gmail.com", user: "hello@mylumahealth.com", pass: "abcdefghijklmnop" },
    ]);
  });

  it("parses multiple comma-separated entries and strips spaces out of the app password", () => {
    expect(parseExtraMailboxes("hello@mylumahealth.com:abcd efgh ijkl mnop, greg@mylumahealth.com:qrst uvwx yzab cdef")).toEqual([
      { host: "imap.gmail.com", user: "hello@mylumahealth.com", pass: "abcdefghijklmnop" },
      { host: "imap.gmail.com", user: "greg@mylumahealth.com", pass: "qrstuvwxyzabcdef" },
    ]);
  });

  it("accepts a space in place of the colon between user and app password — the real-world typo this was written for", () => {
    expect(parseExtraMailboxes("hello@mylumahealth.com ffax ibpx xqzz hwaa")).toEqual([
      { host: "imap.gmail.com", user: "hello@mylumahealth.com", pass: "ffaxibpxxqzzhwaa" },
    ]);
  });

  it("throws on an entry with no separator between user and password at all", () => {
    expect(() => parseExtraMailboxes("hello@mylumahealth.com")).toThrow(/missing the separator/);
  });

  it("throws on an entry with an empty user or password", () => {
    expect(() => parseExtraMailboxes(":abcdefghijklmnop")).toThrow(/empty user or app password/);
    expect(() => parseExtraMailboxes("hello@mylumahealth.com:")).toThrow(/empty user or app password/);
  });
});

describe("imapConfigs", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.GOOGLE_WORKSPACE_SMTP_USER;
    delete process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD;
    delete process.env.EMAIL_INBOUND_EXTRA_MAILBOXES;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when the primary mailbox's user/app password isn't set", () => {
    expect(() => imapConfigs()).toThrow(/GOOGLE_WORKSPACE_SMTP_USER\/GOOGLE_WORKSPACE_SMTP_APP_PASSWORD/);
  });

  /**
   * Google shows an app password as 4 space-separated groups
   * ("ulzq ezgh vjvu lqfg") — pasted exactly as displayed, this used to be
   * sent verbatim (with spaces) as the IMAP password and silently fail
   * login, while the identical raw value going through
   * EMAIL_INBOUND_EXTRA_MAILBOXES's parser already had the whitespace
   * stripped. This locks in that the primary mailbox path strips it too.
   */
  it("strips whitespace from the primary mailbox's app password, same as parseExtraMailboxes already does", () => {
    process.env.GOOGLE_WORKSPACE_SMTP_USER = "help@tryark.com";
    process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "ulzq ezgh vjvu lqfg";
    expect(imapConfigs()).toEqual([{ host: "imap.gmail.com", user: "help@tryark.com", pass: "ulzqezghvjvulqfg" }]);
  });

  it("includes any EMAIL_INBOUND_EXTRA_MAILBOXES entries alongside the primary mailbox", () => {
    process.env.GOOGLE_WORKSPACE_SMTP_USER = "help@tryark.com";
    process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "ulzqezghvjvulqfg";
    process.env.EMAIL_INBOUND_EXTRA_MAILBOXES = "support@tryark.com:thnbsiajgbnvmjhg";
    expect(imapConfigs()).toEqual([
      { host: "imap.gmail.com", user: "help@tryark.com", pass: "ulzqezghvjvulqfg" },
      { host: "imap.gmail.com", user: "support@tryark.com", pass: "thnbsiajgbnvmjhg" },
    ]);
  });
});
