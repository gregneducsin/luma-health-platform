import { describe, expect, it } from "vitest";
import { stripQuotedReply } from "./email-inbound.service.js";

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
