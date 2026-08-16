/**
 * Pre- and post-Claude safety rules for Sarah, the post-purchase support bot.
 *
 * Sarah has zero approved clinical content — unlike Lucy, there is no
 * topic-gated carve-out for dosing/side-effect language. Any patient message
 * asking about prescription specifics (dose, medication choice, side
 * effects, "why was I prescribed this") is routed to staff before Sarah ever
 * drafts a reply. Sarah's own replies may reference prescription/order
 * *status* (written, shipped, tracking number) using the plain factual
 * language the order-state context provides — that's not clinical content,
 * it's fulfillment status — but any clinical language in her own draft is
 * unconditionally rejected, no exceptions.
 *
 * No database imports. No outbound messaging SDK imports.
 */

import { z } from "zod";
import type { SarahInteractiveResult } from "./types.js";
import { APPROVED_REVIEW_URLS, APPROVED_PORTAL_URL, APPROVED_REVIEW_WRITE_URL } from "../messaging/knowledge-catalog.js";

// ── Zod schema for structured provider output ─────────────────────────────────

export const SarahInteractiveSchema = z
  .object({
    action: z.enum(["reply", "pause", "staff_review", "no_reply"]),
    // 600, not Lucy's 400 — the review-request flow can legitimately need to
    // embed both full approved review URLs (~90 chars alone) plus natural
    // prose in one reply; 400 was observed live to reject valid replies here
    // (a 419-char reply with both URLs + enthusiastic phrasing).
    reply: z.string().max(600).nullable(),
    confidence: z.number().min(0).max(1),
    detectedIntents: z.array(z.string().max(100)).optional().default([]),
    knowledgeTopicsUsed: z.array(z.string().max(100)).optional().default([]),
    requiresStaff: z.boolean().optional().default(false),
    safetyCodes: z.array(z.string()).optional().default([]),
    nextQuestion: z.string().max(300).nullable().optional().default(null),
    inboundSentiment: z.enum(["positive", "neutral", "negative"]).nullable().optional().default(null),
  })
  .superRefine((data, ctx) => {
    const needsReply = ["reply", "pause"].includes(data.action);
    if (needsReply && !data.reply) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `reply must be a non-empty string for action: ${data.action}`, path: ["reply"] });
    }
    const mustBeNull = ["staff_review", "no_reply"].includes(data.action);
    if (mustBeNull && data.reply !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `reply must be null for action: ${data.action}`, path: ["reply"] });
    }
  });

// ── Pre-check keyword lists ───────────────────────────────────────────────────

const OPT_OUT_WORDS_UPPER = ["STOP", "UNSUBSCRIBE"] as const;
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
const STOP_WORDS_UPPER = ["END", "QUIT"] as const;
const EMERGENCY_WORDS_LOWER = ["emergency", "crisis", "suicide", "self-harm", "self harm", "911"] as const;
const LEGAL_WORDS_LOWER = ["attorney", "lawyer", "lawsuit", "sue ", "sue,", " suing", "litigation", "legal action"] as const;

/**
 * Any question about prescription specifics — dose, medication identity,
 * refill changes, side effects, "is this safe" — routes straight to staff.
 * Sarah has no approved content to answer any of these; unlike Lucy's
 * MEDICAL_WORDS_LOWER (which has topic-gated post-check carve-outs), there
 * is deliberately no exception path here.
 */
const PRESCRIPTION_QUESTION_PHRASES_LOWER = [
  // Dose specifics — any mention at all routes to staff. Was previously
  // limited to "what dose"/"my dose"/specific increase-decrease phrasings,
  // which missed plain rephrasings like "how many mg do I take" or
  // "my dose hasn't changed" that don't happen to match one of the
  // anticipated patterns. Bare "dose"/"mg" catches the concept regardless
  // of phrasing — there's no legitimate non-clinical reason for a patient
  // message to contain either word.
  "dose",
  "doses",
  "dosage",
  "dosing",
  "mg",
  "side effect",
  "diagnosis",
  "diagnose",
  "symptom",
  "why was i prescribed",
  "why am i prescribed",
  "why did you prescribe",
  "why am i on",
  "what medication am i",
  "which medication am i",
  "what am i taking",
  "what am i on",
  "change my prescription",
  "different medication",
  "switch my medication",
  "change the medication",
  "refill early",
  "is it safe",
  "interact with",
  "allergic",
  "contraindicat",
] as const;

export type SupportPreCheckResult = { readonly blocked: false } | { readonly blocked: true; readonly code: string };

/**
 * Priority order: opt_out > STOP_WORD > emergency > prescription_question > legal.
 */
export function supportPreCheck(lastInbound: string): SupportPreCheckResult {
  const upper = lastInbound.toUpperCase();
  const lower = lastInbound.toLowerCase();
  const tokens = upper.split(/\W+/);

  if (OPT_OUT_WORDS_UPPER.some((w) => tokens.includes(w))) return { blocked: true, code: "OPT_OUT" };
  if (OPT_OUT_PHRASES_LOWER.some((w) => lower.includes(w))) return { blocked: true, code: "OPT_OUT" };
  if (STOP_WORDS_UPPER.some((w) => tokens.includes(w))) return { blocked: true, code: "STOP_WORD" };
  if (EMERGENCY_WORDS_LOWER.some((w) => lower.includes(w))) return { blocked: true, code: "EMERGENCY_CONTENT" };
  if (PRESCRIPTION_QUESTION_PHRASES_LOWER.some((w) => lower.includes(w))) return { blocked: true, code: "PRESCRIPTION_QUESTION" };
  if (LEGAL_WORDS_LOWER.some((w) => lower.includes(w))) return { blocked: true, code: "LEGAL_CONTENT" };

  return { blocked: false };
}

// ── Post-check patterns ───────────────────────────────────────────────────────

/**
 * Matches a URL WITH OR WITHOUT an explicit http(s):// scheme — see the
 * matching comment in messaging/safety.ts for why the scheme is optional.
 */
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co)\b(?:\/[^\s)]*)?/gi;

/** Strips scheme/www/trailing-slash so an approved URL still matches whether or not Sarah echoes its scheme. */
function normalizeUrlForComparison(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const ALLOWED_URLS = new Set([...APPROVED_REVIEW_URLS, APPROVED_PORTAL_URL, APPROVED_REVIEW_WRITE_URL]);
const ALLOWED_URLS_NORMALIZED = new Set([...ALLOWED_URLS].map(normalizeUrlForComparison));

/**
 * Clinical content in Sarah's OWN reply — always rejected, no exceptions.
 * Unlike Lucy, there is no topic that unlocks any of this language.
 * "prescription" as a plain status noun ("your prescription was written")
 * is NOT blocked here — only clinical specifics are.
 */
const SARAH_PROHIBITED_CLINICAL_RE = [
  /\bdiagnos(e|is|ed|ing)\b/i,
  // Was verb-only (contraindicated); "contraindication(s)" (the noun form) is
  // an equally common phrasing and was slipping through unblocked.
  /\bcontraindicat(e|ed|es|ing|ion|ions)\b/i,
  /\bsymptom/i,
  // Was "dosage/dosing" only — bare "dose"/"doses" ("your dose hasn't
  // changed") is the single most natural way to phrase this and wasn't
  // blocked at all.
  /\bdos(e|es|age|ages|ing)\b/i,
  /\bside.?effect/i,
  /\b\d+\s?mg\b/i,
  /\bsemaglutide\b/i,
  /\btirzepatide\b/i,
  // Brand names — Sarah should never need to name a specific medication,
  // generic or brand, but the generic-name check above didn't cover these.
  /\bozempic\b/i,
  /\bwegovy\b/i,
  /\bmounjaro\b/i,
  /\bzepbound\b/i,
] as const;

const STAFF_AVAIL_RE = /\b(monitoring|monitored|watching|standing\s+by|on\s+call).{0,40}(24\/7|around\s+the\s+clock|all\s+the\s+time|right\s+now)\b/i;

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"—\-]+/g, "")
    .replace(/\s+/g, " ");
}

export type SupportPostCheckResult = { readonly ok: true; readonly result: SarahInteractiveResult } | { readonly ok: false; readonly code: string };

const REPLY_TYPE_ACTIONS = new Set(["reply"]);
const NO_QUESTION_ACTIONS = new Set(["pause", "staff_review", "no_reply"]);

/**
 * Validate Sarah's raw provider response.
 *
 * Hard rejections (returns ok:false): UNAPPROVED_URL, PROHIBITED_CLINICAL,
 * PROHIBITED_STAFF_CLAIM, REPEATED_DRAFT, LOW_CONFIDENCE,
 * UNKNOWN_KNOWLEDGE_TOPIC, MISSING_NEXT_QUESTION, INVALID_NEXT_QUESTION,
 * QUESTION_MARK_IN_REPLY, UNEXPECTED_NEXT_QUESTION.
 */
export function supportPostCheck(
  raw: SarahInteractiveResult,
  lastDraft: string | null,
  permittedTopicKeys: ReadonlySet<string> = new Set(),
): SupportPostCheckResult {
  const { reply } = raw;

  if (reply !== null) {
    URL_RE.lastIndex = 0;
    const urlMatches = [...reply.matchAll(URL_RE)];
    for (const match of urlMatches) {
      const url = match[0].replace(/[.,;)'"]+$/, "");
      if (!ALLOWED_URLS_NORMALIZED.has(normalizeUrlForComparison(url))) {
        return { ok: false, code: "UNAPPROVED_URL" };
      }
    }

    // A "?" that's part of an approved URL's own query string (e.g.
    // ?brand_id=27277) isn't a clarifying question — strip matched URLs
    // before checking, so only a real "?" elsewhere in the text trips this.
    URL_RE.lastIndex = 0;
    const replyWithoutUrls = reply.replace(URL_RE, "");
    if (replyWithoutUrls.includes("?")) {
      return { ok: false, code: "QUESTION_MARK_IN_REPLY" };
    }

    if (SARAH_PROHIBITED_CLINICAL_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "PROHIBITED_CLINICAL" };
    }

    if (STAFF_AVAIL_RE.test(reply)) {
      return { ok: false, code: "PROHIBITED_STAFF_CLAIM" };
    }

    if (lastDraft !== null && normalizeForComparison(reply) === normalizeForComparison(lastDraft)) {
      return { ok: false, code: "REPEATED_DRAFT" };
    }

    if (raw.confidence < 0.5) {
      return { ok: false, code: "LOW_CONFIDENCE" };
    }
  }

  if (permittedTopicKeys.size > 0) {
    for (const key of raw.knowledgeTopicsUsed) {
      if (!permittedTopicKeys.has(key)) {
        return { ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" };
      }
    }
  }

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
  } else if (NO_QUESTION_ACTIONS.has(raw.action)) {
    if (raw.nextQuestion !== null && raw.nextQuestion !== undefined) {
      return { ok: false, code: "UNEXPECTED_NEXT_QUESTION" };
    }
  }

  const effectiveRaw: SarahInteractiveResult =
    raw.requiresStaff && raw.action !== "staff_review" ? { ...raw, action: "staff_review", reply: null, nextQuestion: null } : raw;

  return { ok: true, result: effectiveRaw };
}
