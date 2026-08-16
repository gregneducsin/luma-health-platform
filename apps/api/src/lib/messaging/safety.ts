/**
 * Pre- and post-Claude safety rules for the interactive bot-preview reply.
 *
 * Pre-check: STOP, emergency, medical, legal, and suitability content
 * short-circuits the provider and returns a deterministic result.
 *
 * Post-check: validates the structured provider response and rejects replies
 * containing unapproved URLs, clinical language, unsupported pricing claims,
 * staff availability promises, disallowed template variables, repeated drafts,
 * invalid slot updates, unsupported knowledge-topic references, malformed
 * nextQuestion fields, or reply-order violations.
 *
 * Mandatory reply-order rule (action=reply):
 *   Every visible reply must follow STATEMENT → QUESTION order.
 *   The question must be the final sentence, `nextQuestion` must exactly equal
 *   that final sentence, and no preceding sentence may contain a "?".
 *
 * No database imports. No outbound messaging SDK imports.
 */

import { z } from "zod";
import type { ClaudeInteractiveResult } from "./types.js";
import { APPROVED_REVIEW_URLS, APPROVED_PRICING_TOPIC_KEYS, PRODUCT_PRICING_TOPIC_KEYS } from "./knowledge-catalog.js";

// ── Zod schema for structured provider output ─────────────────────────────────

export const ClaudeInteractiveSchema = z
  .object({
    action: z.enum([
      "reply",
      "send_form",
      "pause",
      "staff_review",
      "no_reply",
      // Legacy action names — accepted for backward compatibility.
      "ask_product",
      "explain_process",
      "explain_pricing",
      "explain_inclusions",
    ]),
    reply: z.string().max(400).nullable(),
    confidence: z.number().min(0).max(1),
    /** Primary field — list of detected intents. */
    detectedIntents: z.array(z.string().max(100)).optional().default([]),
    /** Legacy single-intent field — kept for backward compat. */
    detectedIntent: z.string().max(100).optional().default("unknown"),
    /** Knowledge-catalog keys cited in this response. */
    knowledgeTopicsUsed: z.array(z.string().max(100)).optional().default([]),
    /** True when Claude itself flags the turn as requiring staff escalation. */
    requiresStaff: z.boolean().optional().default(false),
    slotUpdates: z.record(z.string(), z.unknown()).optional().default({}),
    resumeTopic: z.string().nullable().optional().default(null),
    safetyCodes: z.array(z.string()).optional().default([]),
    /**
     * The single follow-up question appended to every action=reply message.
     * Required for reply-type actions; must be null for non-reply actions.
     */
    nextQuestion: z.string().max(300).nullable().optional().default(null),
    /**
     * True when Claude is providing the approved intake URL in this reply.
     * The client persists this so Claude is not asked to repeat the link.
     */
    linkProvided: z.boolean().optional().default(false),
    /**
     * Objection-handling stage this reply represents (0, 1, or 2). Combined
     * with the client-side frame to select the next stage's script — see
     * ClaudeInteractiveResult.objectionStage in types.ts for the stage meanings.
     */
    objectionStage: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().default(0),
    /** True once the first_month_offer topic has been used at any point this session. */
    promoOffered: z.boolean().optional().default(false),
    /** Sentiment of the customer's most recent inbound message. Null with no inbound to react to. */
    inboundSentiment: z.enum(["positive", "neutral", "negative"]).nullable().optional().default(null),
  })
  .superRefine((data, ctx) => {
    // Actions that require a non-empty reply
    const needsReply = ["reply", "pause", "send_form", "ask_product", "explain_process", "explain_pricing", "explain_inclusions"].includes(
      data.action,
    );

    if (needsReply && !data.reply) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reply must be a non-empty string for action: ${data.action}`,
        path: ["reply"],
      });
    }

    // Actions that require reply=null
    const mustBeNull = ["staff_review", "no_reply"].includes(data.action);
    if (mustBeNull && data.reply !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reply must be null for action: ${data.action}`,
        path: ["reply"],
      });
    }
  });

// ── Pre-check keyword lists ───────────────────────────────────────────────────

/**
 * Single-word opt-out tokens (matched as whole tokens in the upper-cased message).
 * Checked before STOP_WORDS_UPPER. All produce code "OPT_OUT".
 */
const OPT_OUT_WORDS_UPPER = ["STOP", "UNSUBSCRIBE"] as const;

/**
 * Phrase-based opt-out markers (substring match in the lower-cased message).
 * All produce code "OPT_OUT". Checked after OPT_OUT_WORDS_UPPER.
 */
const OPT_OUT_PHRASES_LOWER = [
  "don't contact me",
  "do not contact me",
  "don't text me",
  "do not text me",
  "leave me alone",
  "remove me from your list",
  "take me off your list",
  "stop contacting me",
] as const;

/**
 * Other stop-word tokens that trigger STOP_WORD (→ staff_review, not opt_out).
 *
 * "CANCEL" is intentionally excluded. As a bare word-boundary token it
 * fires on policy questions like "can i cancel it whenever?" — producing a
 * false opt-out. Standalone "CANCEL" opt-out commands should be handled by a
 * client-side simulator's CANCEL_COMMAND_RE which requires the message to
 * be just "cancel" or to explicitly reference subscription / service cancellation.
 */
const STOP_WORDS_UPPER = ["END", "QUIT"] as const;

const EMERGENCY_WORDS_LOWER = ["emergency", "crisis", "suicide", "self-harm", "self harm", "911"] as const;

const MEDICAL_WORDS_LOWER = [
  "symptom",
  "diagnosis",
  "diagnose",
  "treatment",
  "prescription",
  "prescribe",
  "medication",
  // "side effect" / "side-effect" intentionally omitted here.
  // General "what are the side effects?" questions are handled by the
  // TOPIC_GATED post-check rule (requires side_effects, weight_loss_expectations,
  // or product_comparison topic). Blocking at pre-check prevented Claude
  // from giving approved educational answers.
  "dosage",
  "dosing",
] as const;

const LEGAL_WORDS_LOWER = ["attorney", "lawyer", "lawsuit", "sue ", "sue,", " suing", "litigation", "legal action"] as const;

/**
 * Phrases that indicate a request for individualized clinical suitability
 * judgment. These must never reach the provider — route to staff review.
 */
const SUITABILITY_PHRASES_LOWER = [
  // Substring markers — any message containing these is an individualized request.
  // Using short markers (e.g. "better for me") instead of only full phrases catches
  // contraction forms like "which one's better for me?" (where "one's" ≠ "one is").
  "better for me",
  "right for me",
  "suitable for me",
  // Full-phrase entries for cases where the short marker would be too broad
  "which is better for me",
  "which one is better for me",
  "which medication is better for me",
  "which is right for me",
  "which one is right for me",
  "which medication is right for me",
  "which one should i take",
  "which should i take",
  "which should i use",
  "which one should i use",
  "which would be better for me",
  "am i a good candidate",
  "am i eligible for",
  "would i qualify",
  "is it safe for me to",
  "which one should i get",
  "which do i need",
  "what should i take",
  // Contextual personalization markers
  "my history",
  "my condition",
  "my medical condition", // catches "is this safe with my medical condition?"
  "my situation",
  "recommend for me",
  // Individualized dosing / action requests
  // Note: "should i take" also catches "which one should i take?" but that is
  // already in the list above; the short form captures additional phrasings
  // like "what dose should i take?" without listing every variant separately.
  "should i take",
  "should i increase",
  "should i switch",
  "should i start taking",
  "increase my dose",
  "increase the dose",
] as const;

export type InteractivePreCheckResult = { readonly blocked: false } | { readonly blocked: true; readonly code: string };

/**
 * Check the last inbound message for content that must never reach the
 * provider. Returns the block code or { blocked: false }.
 *
 * Priority order: opt_out > STOP_WORD > emergency > suitability > medical > legal.
 *
 * Opt-out (code "OPT_OUT") takes the highest priority and is terminal —
 * no objection handling, no rebuttal, no provider call.
 */
export function interactivePreCheck(lastInbound: string): InteractivePreCheckResult {
  const upper = lastInbound.toUpperCase();
  const lower = lastInbound.toLowerCase();
  const tokens = upper.split(/\W+/);

  // Opt-out — highest priority; returns terminal OPT_OUT code.
  if (OPT_OUT_WORDS_UPPER.some((w) => tokens.includes(w))) {
    return { blocked: true, code: "OPT_OUT" };
  }
  if (OPT_OUT_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "OPT_OUT" };
  }

  if (STOP_WORDS_UPPER.some((w) => tokens.includes(w))) {
    return { blocked: true, code: "STOP_WORD" };
  }
  if (EMERGENCY_WORDS_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "EMERGENCY_CONTENT" };
  }
  // Suitability is checked before medical so that phrases like
  // "which medication is right for me?" produce SUITABILITY_QUESTION rather
  // than MEDICAL_CONTENT (the word "medication" is in MEDICAL_WORDS_LOWER).
  if (SUITABILITY_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "SUITABILITY_QUESTION" };
  }
  if (MEDICAL_WORDS_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "MEDICAL_CONTENT" };
  }
  if (LEGAL_WORDS_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "LEGAL_CONTENT" };
  }

  return { blocked: false };
}

// ── Post-check patterns ───────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)]+/gi;

/**
 * Clinical content ALWAYS rejected, regardless of which Lucy knowledge topics
 * were declared in knowledgeTopicsUsed. These patterns describe individualized
 * medical actions or conditions that Claude must never perform or assert — even
 * when grounded in a Lucy topic — because they cross from general educational
 * information into individualized clinical judgment.
 *
 * "symptom" is included here because it does not appear in any Lucy approved
 * text and its presence in a reply strongly signals individualized assessment.
 */
const UNCONDITIONAL_CLINICAL_RE = [/\bdiagnos(e|is|ed|ing)\b/i, /\bcontraindicated?\b/i, /\bsymptom/i] as const;

/**
 * Topic-specific language rules.
 *
 * Each entry pairs a sensitive-language pattern with the set of Lucy topic keys
 * that MUST be declared in knowledgeTopicsUsed for the pattern to be permitted.
 * If none of the required topics is declared, the reply is rejected with `code`.
 *
 * A Set with multiple keys means the pattern is legitimately used in more than
 * one topic's approved content. Any one of the listed keys is sufficient.
 *
 * Words not listed here are never independently blocked:
 *   "medication", "prescription" (noun), "dose" (noun), "titration".
 */
interface TopicSpecificRule {
  readonly pattern: RegExp;
  readonly requiredTopics: ReadonlySet<string>;
  readonly code: "PROHIBITED_CLINICAL" | "UNSUPPORTED_PRICING_CLAIM";
}

const TOPIC_SPECIFIC_LANGUAGE: readonly TopicSpecificRule[] = [
  {
    // "dosing" / "dosage" — dose-progression educational content
    // Requires: titration
    pattern: /\bdos(age?|ing)\b/i,
    requiredTopics: new Set(["titration"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // "prescribed" / "prescribe" — transfer-patient context only
    // Requires: previous_prescriptions
    pattern: /\bprescri(be|bed)\b/i,
    requiredTopics: new Set(["previous_prescriptions"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // "treatment" — appears in both transfer-patient context ("transferring treatment")
    //               and titration context ("your treatment process").
    // Requires: previous_prescriptions OR titration
    pattern: /\btreat(ment|ing|ed|s)\b/i,
    requiredTopics: new Set(["previous_prescriptions", "titration"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // Injection language — titration or product-comparison educational context
    // Requires: titration OR product_comparison
    pattern: /\binject(ion|ing|ed)?\b/i,
    requiredTopics: new Set(["titration", "product_comparison"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // "side effects" — allowed with the dedicated side_effects topic, or when
    // discussing product comparison / weight-loss expectations more broadly.
    // Requires: side_effects OR weight_loss_expectations OR product_comparison
    pattern: /\bside.?effect/i,
    requiredTopics: new Set(["side_effects", "weight_loss_expectations", "product_comparison"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // Payment platform names — only in insurance / payment-options context.
    // A reply mentioning Affirm, Klarna, or Afterpay without the insurance_payment
    // topic is an unsupported pricing / payment claim.
    // Requires: insurance_payment
    pattern: /\b(affirm|klarna|afterpay)\b/i,
    requiredTopics: new Set(["insurance_payment"]),
    code: "UNSUPPORTED_PRICING_CLAIM",
  },
];

/**
 * Claims always rejected regardless of which knowledge topics were used.
 * Dollar amounts are handled separately (topic-gated).
 * "insurance" is also handled separately (topic-gated to insurance_payment).
 */
const GUARANTEED_PRICING_RE = [/\bfree\s+(trial|month|consultation)\b/i, /\bguarantee[sd]?\b/i, /\bfully?\s+covered\b/i] as const;

/**
 * Unsupported financing-term claims — always rejected regardless of which
 * knowledge topics were used. These phrases imply availability, eligibility,
 * or terms for BNPL / payment-plan financing that are not approved text.
 *
 *   "available at checkout" — implies automatic platform integration not promised.
 *   "everyone qualifies"    — implies guaranteed eligibility for all applicants.
 *   "no credit check"       — implies a specific underwriting guarantee we cannot make.
 *   "zero interest"         — invents financing terms absent from approved language.
 *
 * Declaring the insurance_payment topic does NOT unlock these phrases.
 */
const UNSUPPORTED_FINANCING_RE = [
  /\bavailable\s+at\s+checkout\b/i,
  /\beveryone\s+qualifies\b/i,
  /\bno\s+credit[\s-]check\b/i,
  /\bzero[\s-]interest\b/i,
] as const;

/**
 * Insurance-acceptance verb patterns used by hasUnnegatedInsuranceAcceptance().
 * All use the /gi flag; callers must reset lastIndex before use.
 *
 * Covered forms:
 *   accept / accepts / accepted [0–3 intervening words] insurance
 *   insurance [auxiliary] accepted  (passive: "insurance is accepted", "may be accepted")
 *   work / works / worked with [0–2 words] insurance
 *   bill / bills / billed [0–2 words] insurance
 */
const INSURANCE_ACCEPTANCE_PATTERNS: readonly RegExp[] = [
  /\baccept(?:s|ed)?\s+(?:\w+\s+){0,3}insurance\b/gi,
  /\binsurance\s+(?:(?:is|are|was|were|gets?)\s+|(?:will|may|might|could|should)\s+be\s+)accepted\b/gi,
  /\bwork(?:s|ed)?\s+with\s+(?:\w+\s+){0,2}insurance\b/gi,
  /\bbill(?:s|ed)?\s+(?:\w+\s+){0,2}insurance\b/gi,
];

/**
 * Negation markers that, when present before an insurance-acceptance verb within its
 * clause, indicate the claim is correctly negated (approved form).
 */
const INSURANCE_ACCEPTANCE_NEGATION_RE =
  /\b(don't|do\s+not|doesn't|does\s+not|didn't|did\s+not|won't|will\s+not|can't|cannot|could\s+not|may\s+not|might\s+not|never|not)\b/;

/**
 * Insurance mention — permitted when the insurance_payment Lucy topic is
 * declared in knowledgeTopicsUsed, e.g.
 *   "We don't accept insurance, but payment options are available through …"
 * Blocked (UNSUPPORTED_PRICING_CLAIM) when no insurance_payment topic is declared.
 */
const INSURANCE_MENTION_RE = /\binsur(e|ance)\b/i;

/** Dollar-amount pattern — only blocked when no approved pricing topic is used. */
const DOLLAR_AMOUNT_RE = /\$\d+/;

/**
 * The only approved promotional discount amount.
 * When first_month_offer is the sole pricing topic declared (no product pricing topic),
 * any dollar amount in the reply must match this; other amounts are invented discounts.
 */
const APPROVED_PROMOTION_AMOUNT_RE = /\$20\b/;

/**
 * Affirmative stacking claim — always blocked.
 * "can be combined with" / "stackable" / "stacks with" promise stacking which is
 * prohibited by the first_month_offer approved text ("cannot be combined with another
 * promotion").
 *
 * Does NOT match "cannot be combined" — the negative form is the correct approved language.
 */
const PROMOTION_STACKING_RE = /\bcan\s+be\s+combin(ed|able)\s+with\b|\bstack(able|s\s+with)\b/i;

/**
 * Non-new-customer eligibility claim — always blocked when first_month_offer is declared.
 * Catches language that implies returning or previous customers qualify for the $20 offer.
 */
const PROMOTION_ELIGIBILITY_VIOLATION_RE =
  /\b(returning|previous|prior|existing)\s+(customers?|patients?)\s+(can|are)\s+(also\s+)?(get|receive|eligible?|qualify)\b/i;

const STAFF_AVAIL_RE = /\b(monitoring|monitored|watching|standing\s+by|on\s+call).{0,40}(24\/7|around\s+the\s+clock|all\s+the\s+time|right\s+now)\b/i;

// Allowed template variable names
const ALLOWED_TEMPLATE_NAMES = new Set([
  "UNIVERSAL_SIGNUP_LINK",
  "SEMAGLUTIDE_PRICING_PENDING_APPROVAL",
  "TIRZEPATIDE_PRICING_PENDING_APPROVAL",
  "PROCESS_DESCRIPTION_PENDING_APPROVAL",
  "PLAN_INCLUSIONS_PENDING_APPROVAL",
]);

const TEMPLATE_VAR_RE = /\[([A-Z_]+)\]/g;

// Allowed slot keys and the values each accepts
const SLOT_VALIDATORS: Record<string, readonly (string | null)[]> = {
  selectedProduct: [null, "semaglutide", "tirzepatide"],
  currentlyTaking: [null, "yes", "no"],
  wantsProcessExplanation: [null, "yes", "no"],
  hasTimeForIntake: [null, "yes", "no"],
  wantsPlanInclusions: [null, "yes", "no"],
  readyForForm: [null, "yes", "no"],
};

// Actions for which nextQuestion must be a valid single question
const REPLY_TYPE_ACTIONS = new Set(["reply", "ask_product", "explain_process", "explain_pricing", "explain_inclusions"]);

// Actions for which nextQuestion must be null
const NO_QUESTION_ACTIONS = new Set(["pause", "send_form", "staff_review", "no_reply"]);

/**
 * Returns true when the reply contains an affirmative (un-negated) insurance-
 * acceptance claim. The only approved insurance policy is that Luma does NOT
 * accept insurance; any form that implies it may be accepted must be rejected.
 *
 * Detection strategy — normalise-and-verify (not a pure lookbehind):
 *
 *  1. Scan for every occurrence of an insurance-acceptance verb pattern.
 *  2. Extract the "negation zone": text from the start of the containing clause
 *     (bounded by the nearest preceding .!?;, character) to the start of the
 *     matched verb phrase. Commas are included as clause separators so that an
 *     adversative sub-clause ("…, but we also accept insurance") is correctly
 *     isolated from an earlier negation ("We don't accept insurance,…").
 *  3. If a clear negation marker (don't, do not, cannot, never, …) appears in the
 *     negation zone, the claim is correctly negated → pass.
 *  4. If no negation marker is found for any occurrence → block (returns true).
 *
 * Approved forms (must pass):
 *   "We don't accept insurance."
 *   "We do not accept insurance."
 *   "We don't accept insurance, but payment options are available through Affirm,
 *    Klarna, and Afterpay, subject to approval."
 *
 * Rejected regardless of topic declared (must fail):
 *   "We accept insurance."              "Luma accepts insurance."
 *   "Insurance is accepted."            "We can accept insurance."
 *   "We may accept insurance."          "We accept some insurance."
 *   "We accept insurance indirectly."   "Your insurance is accepted."
 *   "We work with your insurance."      "We can bill your insurance."
 */
function hasUnnegatedInsuranceAcceptance(reply: string): boolean {
  const lower = reply.toLowerCase();

  for (const pattern of INSURANCE_ACCEPTANCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      // Locate the start of the containing clause: scan backward from the match
      // for the nearest sentence-ending punctuation or comma.
      let clauseStart = 0;
      for (let i = match.index - 1; i >= 0; i--) {
        const ch = lower[i];
        if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === ",") {
          clauseStart = i + 1;
          break;
        }
      }
      // Negation zone: text between clause start and the start of the matched verb.
      const negationZone = lower.substring(clauseStart, match.index);
      if (!INSURANCE_ACCEPTANCE_NEGATION_RE.test(negationZone)) {
        return true; // affirmative insurance-acceptance claim → block
      }
    }
  }

  return false;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"—\-]+/g, "")
    .replace(/\s+/g, " ");
}

// ── Reply sentence-order helpers ──────────────────────────────────────────────

export type InteractivePostCheckResult =
  | { readonly ok: true; readonly result: ClaudeInteractiveResult; readonly validatedSlotUpdates: Record<string, unknown> }
  | { readonly ok: false; readonly code: string };

/**
 * Validate the raw provider response.
 *
 * Hard rejections (returns ok:false):
 *   UNAPPROVED_URL, PROHIBITED_CLINICAL, UNSUPPORTED_PRICING_CLAIM,
 *   PROHIBITED_STAFF_CLAIM, DISALLOWED_TEMPLATE, REPEATED_DRAFT,
 *   LOW_CONFIDENCE, INVALID_SLOT_KEY, INVALID_SLOT_VALUE,
 *   UNKNOWN_KNOWLEDGE_TOPIC, MISSING_NEXT_QUESTION, INVALID_NEXT_QUESTION
 *
 * @param permittedTopicKeys  Set of knowledge topic keys that were sent to the
 *   provider. Any key in knowledgeTopicsUsed that is not in this set is
 *   rejected as UNKNOWN_KNOWLEDGE_TOPIC. Pass an empty Set to skip the check.
 */
export function interactivePostCheck(
  raw: ClaudeInteractiveResult,
  lastDraft: string | null,
  permittedTopicKeys: ReadonlySet<string> = new Set(),
): InteractivePostCheckResult {
  const { reply } = raw;

  if (reply !== null) {
    // URL — only the fixed review-site URLs are allowed. No intake/signup URL
    // is ever allowlisted here: those are minted per-lead server-side (see
    // knowledge-catalog.ts's APPROVED_REVIEW_URLS docstring) and Claude must
    // never output one, even a real one from a prior turn.
    URL_RE.lastIndex = 0;
    const urlMatches = [...reply.matchAll(URL_RE)];
    for (const match of urlMatches) {
      // Strip trailing punctuation that might be appended by Claude
      const url = match[0].replace(/[.,;)'"]+$/, "");
      if (!APPROVED_REVIEW_URLS.has(url)) {
        return { ok: false, code: "UNAPPROVED_URL" };
      }
    }

    // The question belongs exclusively in nextQuestion. Catches Claude folding a
    // clarifying question into reply and leaving nextQuestion null or mismatched —
    // observed live: Claude re-asking "which one — semaglutide or tirzepatide?"
    // inside reply instead of splitting it out.
    if (reply.includes("?")) {
      return { ok: false, code: "QUESTION_MARK_IN_REPLY" };
    }

    // ── Clinical-language checks ───────────────────────────────────────────────
    const hasInsuranceTopic = raw.knowledgeTopicsUsed.includes("insurance_payment");

    // Always blocked: individualized clinical actions / conditions
    if (UNCONDITIONAL_CLINICAL_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "PROHIBITED_CLINICAL" };
    }

    // Topic-specific language: each pattern requires its designated Lucy topic(s).
    // A reply is rejected if it uses sensitive language without declaring the
    // specific topic that authorises that language. Declaring an unrelated topic
    // does not unlock permission for a different topic's sensitive vocabulary.
    for (const rule of TOPIC_SPECIFIC_LANGUAGE) {
      if (rule.pattern.test(reply)) {
        const hasRequired = raw.knowledgeTopicsUsed.some((k) => rule.requiredTopics.has(k));
        if (!hasRequired) {
          return { ok: false, code: rule.code };
        }
      }
    }

    // Guaranteed / unsupported claims (always blocked)
    if (GUARANTEED_PRICING_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Unsupported financing terms — always blocked, even when insurance_payment is declared.
    // "available at checkout", "everyone qualifies", "no credit check", "zero interest" are
    // not part of any approved messaging and imply guarantees we cannot make.
    if (UNSUPPORTED_FINANCING_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Affirmative insurance-acceptance — always blocked regardless of insurance_payment topic.
    // hasUnnegatedInsuranceAcceptance() normalises the reply and verifies that every
    // insurance-acceptance verb is explicitly negated (don't / do not / cannot / never / …).
    // Approved: "We don't accept insurance." Rejected: "We accept insurance." and all
    // other affirmative / passive / modal forms listed in the function's JSDoc.
    if (hasUnnegatedInsuranceAcceptance(reply)) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Insurance mention: blocked when the insurance_payment topic is not declared
    if (!hasInsuranceTopic && INSURANCE_MENTION_RE.test(reply)) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Dollar-amount claims only blocked when no approved pricing topic was used
    const hasPricingTopic = raw.knowledgeTopicsUsed.some((k) => APPROVED_PRICING_TOPIC_KEYS.has(k));
    if (!hasPricingTopic && DOLLAR_AMOUNT_RE.test(reply)) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // ── Promotion-specific rules (active whenever first_month_offer is declared) ─
    const hasFirstMonthOffer = raw.knowledgeTopicsUsed.includes("first_month_offer");

    if (hasFirstMonthOffer) {
      // Stacking claims are always prohibited — the approved text explicitly states
      // "cannot be combined with another promotion."
      if (PROMOTION_STACKING_RE.test(reply)) {
        return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
      }

      // Non-new-customer eligibility — discount applies to new customers only.
      if (PROMOTION_ELIGIBILITY_VIOLATION_RE.test(reply)) {
        return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
      }

      // Invented discount amount — when first_month_offer is the only pricing topic
      // (no product pricing topic declared), any dollar amount must be exactly $20.
      const hasProductPricingTopic = raw.knowledgeTopicsUsed.some((k) => PRODUCT_PRICING_TOPIC_KEYS.has(k));
      if (!hasProductPricingTopic && DOLLAR_AMOUNT_RE.test(reply) && !APPROVED_PROMOTION_AMOUNT_RE.test(reply)) {
        return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
      }
    }

    // Staff availability claim
    if (STAFF_AVAIL_RE.test(reply)) {
      return { ok: false, code: "PROHIBITED_STAFF_CLAIM" };
    }

    // Disallowed template variables
    const templateMatches = [...reply.matchAll(TEMPLATE_VAR_RE)];
    for (const match of templateMatches) {
      if (!ALLOWED_TEMPLATE_NAMES.has(match[1])) {
        return { ok: false, code: "DISALLOWED_TEMPLATE" };
      }
    }

    // Repeated draft
    if (lastDraft !== null && normalizeForComparison(reply) === normalizeForComparison(lastDraft)) {
      return { ok: false, code: "REPEATED_DRAFT" };
    }

    // Low confidence — hard reject (caller can choose to surface to staff)
    if (raw.confidence < 0.5) {
      return { ok: false, code: "LOW_CONFIDENCE" };
    }
  }

  // Knowledge-topic validation: reject any topic Claude cited that was not in
  // the permitted set we sent it. Skip the check when permittedTopicKeys is
  // empty (e.g. tests that do not exercise the knowledge path).
  if (permittedTopicKeys.size > 0) {
    for (const key of raw.knowledgeTopicsUsed) {
      if (!permittedTopicKeys.has(key)) {
        return { ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" };
      }
    }
  }

  // nextQuestion validation + mandatory STATEMENT → QUESTION order check
  if (REPLY_TYPE_ACTIONS.has(raw.action)) {
    const nq = raw.nextQuestion;
    if (nq === null || nq === undefined || nq.trim() === "") {
      return { ok: false, code: "MISSING_NEXT_QUESTION" };
    }
    const trimmed = nq.trim();
    if (!trimmed.endsWith("?")) {
      return { ok: false, code: "INVALID_NEXT_QUESTION" };
    }
    const qCount = (trimmed.match(/\?/g) ?? []).length;
    if (qCount !== 1) {
      return { ok: false, code: "INVALID_NEXT_QUESTION" };
    }
    // reply and nextQuestion are separate messages — no order check needed.
    // The question lives exclusively in nextQuestion; reply is informational only.
  } else if (NO_QUESTION_ACTIONS.has(raw.action)) {
    if (raw.nextQuestion !== null && raw.nextQuestion !== undefined) {
      return { ok: false, code: "UNEXPECTED_NEXT_QUESTION" };
    }
  }

  // If Claude itself flagged requiresStaff, override the action to staff_review.
  // This provides a safety net for suitability questions that slip through
  // the pre-check; Claude's reply is discarded.
  const effectiveRaw: ClaudeInteractiveResult =
    raw.requiresStaff && raw.action !== "staff_review" ? { ...raw, action: "staff_review", reply: null, nextQuestion: null } : raw;

  // Validate slot updates
  const rawSlotUpdates = effectiveRaw.slotUpdates as Record<string, unknown>;
  const validatedSlotUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSlotUpdates)) {
    const allowed = SLOT_VALIDATORS[key];
    if (!allowed) {
      return { ok: false, code: `INVALID_SLOT_KEY` };
    }
    if (!allowed.includes(value as string | null)) {
      return { ok: false, code: `INVALID_SLOT_VALUE` };
    }
    validatedSlotUpdates[key] = value;
  }

  return { ok: true, result: effectiveRaw, validatedSlotUpdates };
}
