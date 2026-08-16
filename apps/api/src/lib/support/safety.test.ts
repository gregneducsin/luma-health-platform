import { describe, it, expect } from "vitest";
import { supportPreCheck, supportPostCheck } from "./safety.js";
import type { SarahInteractiveResult } from "./types.js";

function reply(overrides: Partial<SarahInteractiveResult> = {}): SarahInteractiveResult {
  return {
    action: "reply",
    reply: "Your order has been received and is with the doctor for review.",
    confidence: 0.9,
    detectedIntents: [],
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    safetyCodes: [],
    nextQuestion: "Is there anything else I can help with?",
    inboundSentiment: null,
    ...overrides,
  };
}

describe("supportPreCheck", () => {
  it("passes ordinary messages", () => {
    expect(supportPreCheck("When will my order ship?")).toEqual({ blocked: false });
  });

  it("blocks STOP as opt-out", () => {
    expect(supportPreCheck("STOP")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("blocks emergency content", () => {
    expect(supportPreCheck("this is an emergency")).toEqual({ blocked: true, code: "EMERGENCY_CONTENT" });
  });

  it("blocks prescription-specific questions", () => {
    expect(supportPreCheck("what dosage am I on")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("can I change my prescription")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("what side effects should I expect")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
  });

  it("does not block plain order/shipping questions", () => {
    expect(supportPreCheck("where is my tracking number")).toEqual({ blocked: false });
    expect(supportPreCheck("how do I log into the portal")).toEqual({ blocked: false });
  });

  it("blocks legal content", () => {
    expect(supportPreCheck("I'm going to get my lawyer involved")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
  });
});

function check(raw: SarahInteractiveResult, lastDraft: string | null = null, permittedTopicKeys?: ReadonlySet<string>) {
  return permittedTopicKeys ? supportPostCheck(raw, lastDraft, permittedTopicKeys) : supportPostCheck(raw, lastDraft);
}

describe("supportPostCheck", () => {
  it("accepts an ordinary reply", () => {
    const result = check(reply());
    expect(result.ok).toBe(true);
  });

  it("rejects an unapproved URL", () => {
    const result = check(reply({ reply: "Check here: https://example.com/random" }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("accepts the approved portal URL", () => {
    const result = check(reply({ reply: "You can check that in the portal: https://go.mylumahealth.com/login" }));
    expect(result.ok).toBe(true);
  });

  it("accepts the approved write-a-review URL, even though its query string contains a '?'", () => {
    const result = check(
      reply({ reply: "We'd love it if you left a review: https://www.consumeraffairs.com/review/write/?brand_id=27277" }),
    );
    expect(result.ok).toBe(true);
  });

  it("still rejects a genuine clarifying question mark alongside an approved URL with a query string", () => {
    const result = check(
      reply({ reply: "Would you leave a review? Here's the link: https://www.consumeraffairs.com/review/write/?brand_id=27277" }),
    );
    expect(result).toEqual({ ok: false, code: "QUESTION_MARK_IN_REPLY" });
  });

  it("rejects a question mark inside reply", () => {
    const result = check(reply({ reply: "Do you want me to check on that?" }));
    expect(result).toEqual({ ok: false, code: "QUESTION_MARK_IN_REPLY" });
  });

  it("rejects clinical language in Sarah's own reply, even mentioning a medication name", () => {
    const result = check(reply({ reply: "Your tirzepatide dose is being adjusted." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects dosage/side-effect language unconditionally", () => {
    expect(check(reply({ reply: "The dosing schedule is 5mg weekly." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Side effects are common with this medication." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("allows the plain word 'prescription' as a status noun", () => {
    const result = check(reply({ reply: "Your prescription was written and sent to the pharmacy." }));
    expect(result.ok).toBe(true);
  });

  it("rejects a repeated draft", () => {
    const draft = "Your order shipped today.";
    const result = check(reply({ reply: draft }), draft);
    expect(result).toEqual({ ok: false, code: "REPEATED_DRAFT" });
  });

  it("requires nextQuestion for action=reply", () => {
    const result = check(reply({ nextQuestion: null }));
    expect(result).toEqual({ ok: false, code: "MISSING_NEXT_QUESTION" });
  });

  it("rejects nextQuestion for action=pause", () => {
    const result = check(reply({ action: "pause", nextQuestion: "Anything else?" }));
    expect(result).toEqual({ ok: false, code: "UNEXPECTED_NEXT_QUESTION" });
  });

  it("overrides action to staff_review when requiresStaff is true", () => {
    const result = check(reply({ requiresStaff: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("staff_review");
      expect(result.result.reply).toBeNull();
      expect(result.result.nextQuestion).toBeNull();
    }
  });

  it("rejects an unknown knowledge topic when a permitted set is given", () => {
    const result = check(reply({ knowledgeTopicsUsed: ["not_a_real_topic"] }), null, new Set(["portal_help"]));
    expect(result).toEqual({ ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" });
  });
});
