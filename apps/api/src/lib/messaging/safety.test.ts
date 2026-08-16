import { describe, it, expect } from "vitest";
import { interactivePreCheck, interactivePostCheck } from "./safety.js";
import { APPROVED_REVIEW_URLS } from "./knowledge-catalog.js";
import type { ClaudeInteractiveResult } from "./types.js";

function reply(overrides: Partial<ClaudeInteractiveResult> = {}): ClaudeInteractiveResult {
  return {
    action: "reply",
    reply: "Tirzepatide is a popular option.",
    confidence: 0.9,
    detectedIntents: [],
    detectedIntent: "unknown",
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    slotUpdates: {},
    resumeTopic: null,
    safetyCodes: [],
    nextQuestion: "Would you like to go over the pricing?",
    linkProvided: false,
    objectionStage: 0,
    promoOffered: false,
    inboundSentiment: null,
    ...overrides,
  };
}

function check(
  raw: ClaudeInteractiveResult,
  lastDraft: string | null = null,
  permittedTopicKeys?: ReadonlySet<string>,
) {
  return permittedTopicKeys ? interactivePostCheck(raw, lastDraft, permittedTopicKeys) : interactivePostCheck(raw, lastDraft);
}

// ── Pre-check ──────────────────────────────────────────────────────────────

describe("interactivePreCheck", () => {
  it("passes ordinary messages", () => {
    expect(interactivePreCheck("How much is semaglutide?")).toEqual({ blocked: false });
  });

  it("blocks STOP as OPT_OUT", () => {
    expect(interactivePreCheck("STOP")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("blocks UNSUBSCRIBE as OPT_OUT", () => {
    expect(interactivePreCheck("please unsubscribe me")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("blocks opt-out phrases as OPT_OUT", () => {
    expect(interactivePreCheck("please don't contact me again")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("does not treat bare CANCEL as opt-out", () => {
    const result = interactivePreCheck("can i cancel it whenever?");
    expect(result.blocked).toBe(false);
  });

  it("blocks END/QUIT as STOP_WORD", () => {
    expect(interactivePreCheck("quit")).toEqual({ blocked: true, code: "STOP_WORD" });
  });

  it("blocks emergency content", () => {
    expect(interactivePreCheck("this is an emergency")).toEqual({ blocked: true, code: "EMERGENCY_CONTENT" });
  });

  it("blocks suitability questions before medical content", () => {
    // Contains "medication" (a MEDICAL_WORDS_LOWER entry) but should classify as suitability.
    expect(interactivePreCheck("which medication is right for me?")).toEqual({
      blocked: true,
      code: "SUITABILITY_QUESTION",
    });
  });

  it("blocks medical content", () => {
    expect(interactivePreCheck("what's the dosage?")).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
  });

  it("blocks legal content", () => {
    expect(interactivePreCheck("I'm going to sue you")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
  });

  it("does not block general side-effect questions (handled by topic-gated post-check instead)", () => {
    expect(interactivePreCheck("what are the side effects?")).toEqual({ blocked: false });
  });

  it("prioritizes OPT_OUT over other categories", () => {
    expect(interactivePreCheck("STOP, this is an emergency")).toEqual({ blocked: true, code: "OPT_OUT" });
  });
});

// ── Post-check: URL allowlisting ──────────────────────────────────────────────

describe("interactivePostCheck: question mark must stay out of reply", () => {
  it("rejects a reply containing a question mark, even when nextQuestion is also present", () => {
    const result = check(reply({ reply: "Which one would you like, semaglutide or tirzepatide?", nextQuestion: "Which one sounds better?" }));
    expect(result).toEqual({ ok: false, code: "QUESTION_MARK_IN_REPLY" });
  });

  it("allows a reply with no question mark at all", () => {
    const result = check(reply({ reply: "Semaglutide is the more affordable option." }));
    expect(result.ok).toBe(true);
  });
});

describe("interactivePostCheck: URLs", () => {
  it("allows the fixed review-site URLs", () => {
    for (const url of APPROVED_REVIEW_URLS) {
      const result = check(reply({ reply: `Here you go: ${url}` }));
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an intake/signup-shaped URL even if it looks plausible", () => {
    const result = check(reply({ reply: "Here you go: https://start.mylumahealth.com/start-online-visit/863ljl-78f0cabe" }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("rejects any other URL", () => {
    const result = check(reply({ reply: "Sign up here: https://evil.example.com/phish" }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });
});

// ── Post-check: unconditional clinical language ───────────────────────────────

describe("interactivePostCheck: unconditional clinical language", () => {
  it("rejects diagnose regardless of declared topics", () => {
    const result = check(reply({ reply: "I can diagnose your condition.", knowledgeTopicsUsed: ["product_comparison"] }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects contraindicated", () => {
    const result = check(reply({ reply: "That would be contraindicated for you." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects symptom", () => {
    const result = check(reply({ reply: "Tell me about your symptom." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });
});

// ── Post-check: topic-gated language ──────────────────────────────────────────

describe("interactivePostCheck: topic-gated language", () => {
  it("rejects dosing language without the titration topic", () => {
    const result = check(reply({ reply: "Let's talk about dosing.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("allows dosing language with the titration topic declared", () => {
    const result = check(reply({ reply: "Let's talk about dosing.", knowledgeTopicsUsed: ["titration"] }));
    expect(result.ok).toBe(true);
  });

  it("rejects payment-platform names without the insurance_payment topic", () => {
    const result = check(reply({ reply: "We work with Affirm.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });
});

// ── Post-check: pricing / financing claims ────────────────────────────────────

describe("interactivePostCheck: pricing and financing claims", () => {
  it("rejects guaranteed-pricing language", () => {
    const result = check(reply({ reply: "We guarantee the lowest price.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects unsupported financing terms even with insurance_payment declared", () => {
    const result = check(
      reply({ reply: "Financing is available at checkout with no credit check.", knowledgeTopicsUsed: ["insurance_payment"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects dollar amounts with no pricing topic declared", () => {
    const result = check(reply({ reply: "That plan is $80 per month.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("allows dollar amounts with a pricing topic declared", () => {
    const result = check(reply({ reply: "That plan is $80 per month.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    expect(result.ok).toBe(true);
  });
});

// ── Post-check: insurance negation zone ───────────────────────────────────────

describe("interactivePostCheck: insurance-acceptance negation", () => {
  it("allows the approved negated form", () => {
    const result = check(
      reply({ reply: "We don't accept insurance, but payment options are available.", knowledgeTopicsUsed: ["insurance_payment"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an affirmative insurance-acceptance claim even with the topic declared", () => {
    const result = check(reply({ reply: "We accept insurance.", knowledgeTopicsUsed: ["insurance_payment"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects passive affirmative forms", () => {
    const result = check(reply({ reply: "Insurance is accepted.", knowledgeTopicsUsed: ["insurance_payment"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects insurance mention entirely without the topic declared", () => {
    const result = check(reply({ reply: "We don't take insurance.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });
});

// ── Post-check: promotion rules ───────────────────────────────────────────────

describe("interactivePostCheck: first_month_offer promotion rules", () => {
  it("allows the approved $20 offer language", () => {
    const result = check(
      reply({ reply: "New customers get $20 off their first month.", knowledgeTopicsUsed: ["first_month_offer"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects stacking claims", () => {
    const result = check(
      reply({ reply: "This can be combined with other promotions.", knowledgeTopicsUsed: ["first_month_offer"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects non-new-customer eligibility claims", () => {
    const result = check(
      reply({ reply: "Returning customers can also get this discount.", knowledgeTopicsUsed: ["first_month_offer"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects an invented discount amount", () => {
    const result = check(reply({ reply: "New customers get $50 off.", knowledgeTopicsUsed: ["first_month_offer"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });
});

// ── Post-check: staff availability, templates, repeated drafts, confidence ───

describe("interactivePostCheck: other hard rejections", () => {
  it("rejects staff-24/7-availability claims", () => {
    const result = check(reply({ reply: "Our staff is standing by 24/7 to help." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_STAFF_CLAIM" });
  });

  it("allows an approved template variable", () => {
    const result = check(reply({ reply: "Here is your link: [UNIVERSAL_SIGNUP_LINK]" }));
    expect(result.ok).toBe(true);
  });

  it("rejects a disallowed template variable", () => {
    const result = check(reply({ reply: "Here is your link: [SECRET_INTERNAL_VAR]" }));
    expect(result).toEqual({ ok: false, code: "DISALLOWED_TEMPLATE" });
  });

  it("rejects a repeated draft", () => {
    const draft = "Tirzepatide is our most popular option.";
    const result = check(reply({ reply: draft, nextQuestion: "Are you ready to get started?" }), draft);
    expect(result).toEqual({ ok: false, code: "REPEATED_DRAFT" });
  });

  it("treats repeated-draft comparison as punctuation/case-insensitive", () => {
    const result = check(
      reply({ reply: "Tirzepatide is our most popular option!", nextQuestion: "Are you ready to get started?" }),
      "tirzepatide is our most popular option",
    );
    expect(result).toEqual({ ok: false, code: "REPEATED_DRAFT" });
  });

  it("rejects low-confidence replies", () => {
    const result = check(reply({ confidence: 0.2 }));
    expect(result).toEqual({ ok: false, code: "LOW_CONFIDENCE" });
  });
});

// ── Post-check: knowledge-topic gating ────────────────────────────────────────

describe("interactivePostCheck: knowledge-topic gating", () => {
  it("rejects a topic that was not permitted for this turn", () => {
    const result = check(
      reply({ knowledgeTopicsUsed: ["tirzepatide_pricing"] }),
      null,
      new Set(["product_comparison"]),
    );
    expect(result).toEqual({ ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" });
  });

  it("allows a topic that was permitted for this turn", () => {
    const result = check(
      reply({ knowledgeTopicsUsed: ["product_comparison"] }),
      null,
      new Set(["product_comparison"]),
    );
    expect(result.ok).toBe(true);
  });

  it("skips the check entirely when permittedTopicKeys is empty", () => {
    const result = check(reply({ knowledgeTopicsUsed: ["anything_at_all"] }));
    expect(result.ok).toBe(true);
  });
});

// ── Post-check: nextQuestion format ───────────────────────────────────────────

describe("interactivePostCheck: nextQuestion format", () => {
  it("rejects a missing nextQuestion for a reply action", () => {
    const result = check(reply({ nextQuestion: null }));
    expect(result).toEqual({ ok: false, code: "MISSING_NEXT_QUESTION" });
  });

  it("rejects a nextQuestion that doesn't end with a question mark", () => {
    const result = check(reply({ nextQuestion: "Let me know if you're ready" }));
    expect(result).toEqual({ ok: false, code: "INVALID_NEXT_QUESTION" });
  });

  it("rejects a nextQuestion with more than one question mark", () => {
    const result = check(reply({ nextQuestion: "Are you ready? Or do you have questions?" }));
    expect(result).toEqual({ ok: false, code: "INVALID_NEXT_QUESTION" });
  });

  it("rejects an unexpected nextQuestion on a no-question action", () => {
    const result = check(reply({ action: "staff_review", reply: null, nextQuestion: "Are you ready?" }));
    expect(result).toEqual({ ok: false, code: "UNEXPECTED_NEXT_QUESTION" });
  });

  it("allows a well-formed single trailing question", () => {
    const result = check(reply({ nextQuestion: "Would you like to go over the pricing?" }));
    expect(result.ok).toBe(true);
  });
});

// ── Post-check: requiresStaff safety-net override ─────────────────────────────

describe("interactivePostCheck: requiresStaff override", () => {
  it("forces action to staff_review and discards the reply when requiresStaff is true", () => {
    const result = check(reply({ requiresStaff: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("staff_review");
      expect(result.result.reply).toBeNull();
      expect(result.result.nextQuestion).toBeNull();
    }
  });
});

// ── Post-check: slot validation ───────────────────────────────────────────────

describe("interactivePostCheck: slot validation", () => {
  it("accepts a valid slot update", () => {
    const result = check(reply({ slotUpdates: { selectedProduct: "tirzepatide" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ selectedProduct: "tirzepatide" });
    }
  });

  it("rejects an unknown slot key", () => {
    const result = check(reply({ slotUpdates: { notARealSlot: "value" } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_KEY" });
  });

  it("rejects an invalid value for a known slot key", () => {
    const result = check(reply({ slotUpdates: { selectedProduct: "aspirin" } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("accepts a free-text state slot value", () => {
    const result = check(reply({ slotUpdates: { state: "Texas" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ state: "Texas" });
    }
  });

  it("accepts a null state slot value", () => {
    const result = check(reply({ slotUpdates: { state: null } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ state: null });
    }
  });

  it("rejects an empty-string state slot value", () => {
    const result = check(reply({ slotUpdates: { state: "" } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("rejects a state slot value over the length cap", () => {
    const result = check(reply({ slotUpdates: { state: "x".repeat(61) } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("rejects a non-string state slot value", () => {
    const result = check(reply({ slotUpdates: { state: 12 } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });
});
