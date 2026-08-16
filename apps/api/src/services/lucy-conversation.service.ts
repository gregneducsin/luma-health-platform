import { interactivePreCheck, interactivePostCheck } from "../lib/messaging/safety.js";
import { callClaudeInteractive, ProviderError } from "../lib/messaging/provider.js";
import { getPreviewEnabledTopics } from "../lib/messaging/knowledge-catalog.js";
import type { BotPreviewRequestBody, ClaudeInteractiveResult } from "../lib/messaging/types.js";
import { createIntakeLink } from "./intake-links.service.js";
import { logger } from "../lib/logger.js";

export type LucyTurnResult =
  | {
      ok: true;
      action: ClaudeInteractiveResult["action"];
      reply: string | null;
      nextQuestion: string | null;
      link: string | null;
      objectionStage: 0 | 1 | 2;
      linkProvided: boolean;
      promoOffered: boolean;
      inboundSentiment: "positive" | "neutral" | "negative" | null;
      requiresStaff: boolean;
      knowledgeTopicsUsed: readonly string[];
      validatedSlotUpdates: Record<string, unknown>;
      source: "pre_check_block" | "model";
    }
  | { ok: false; code: string };

/** Deterministic replies for pre-check blocks — these never reach Claude. */
const PRE_CHECK_RESULTS: Record<string, { action: "pause" | "staff_review"; reply: string | null }> = {
  OPT_OUT: { action: "pause", reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help." },
  STOP_WORD: { action: "staff_review", reply: null },
  EMERGENCY_CONTENT: { action: "staff_review", reply: null },
  SUITABILITY_QUESTION: { action: "staff_review", reply: null },
  MEDICAL_CONTENT: { action: "staff_review", reply: null },
  LEGAL_CONTENT: { action: "staff_review", reply: null },
};

/**
 * Post-check codes safe to retry: these are mechanical format slips (the
 * question landed in the wrong field, or in two places, or Claude repeated
 * its own last draft), not safety-relevant rejections. Retrying re-runs the
 * exact same prompt — no "you got it wrong" context is added — since this is
 * plain output variance, not a content problem to correct. Every other
 * rejection code (clinical language, unsupported pricing, unapproved URLs,
 * unknown knowledge topics, low confidence, ...) is never retried: those are
 * findings about what Claude said, and repeating the call risks the same
 * violation again or a different one, not fixing anything.
 */
const RETRYABLE_POST_CHECK_CODES = new Set(["MISSING_NEXT_QUESTION", "INVALID_NEXT_QUESTION", "UNEXPECTED_NEXT_QUESTION", "QUESTION_MARK_IN_REPLY", "REPEATED_DRAFT"]);
const MAX_ATTEMPTS = 3;

/**
 * Run one turn of the Lucy conversation loop: pre-check the inbound message,
 * call Claude if it isn't blocked, post-check the response, and — on
 * action=send_form — mint the actual per-lead signup link (Claude never sees
 * or outputs a real one).
 *
 * Fails closed: any pre-check block or a non-retryable post-check rejection
 * short-circuits before the caller ever gets an unvalidated reply — no
 * automatic repair, no second guess at what Claude "meant." A format-only
 * rejection (see RETRYABLE_POST_CHECK_CODES) gets exactly one retry of the
 * same call before giving up the same way.
 */
export async function runLucyTurn(personId: string, body: BotPreviewRequestBody): Promise<LucyTurnResult> {
  const lastInbound = [...body.messages].reverse().find((m) => m.direction === "inbound");
  if (lastInbound) {
    const pre = interactivePreCheck(lastInbound.body);
    if (pre.blocked) {
      const deterministic = PRE_CHECK_RESULTS[pre.code] ?? { action: "staff_review" as const, reply: null };
      return {
        ok: true,
        action: deterministic.action,
        reply: deterministic.reply,
        nextQuestion: null,
        link: null,
        objectionStage: body.objectionStage,
        linkProvided: body.linkProvided,
        promoOffered: body.promoOffered,
        inboundSentiment: null,
        requiresStaff: deterministic.action === "staff_review",
        knowledgeTopicsUsed: [],
        validatedSlotUpdates: {},
        source: "pre_check_block",
      };
    }
  }

  const enabledTopics = getPreviewEnabledTopics();
  const permittedTopicKeys = new Set(enabledTopics.map((t) => t.key));

  let post: ReturnType<typeof interactivePostCheck> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: ClaudeInteractiveResult;
    try {
      raw = await callClaudeInteractive(body, enabledTopics);
    } catch (err) {
      if (err instanceof ProviderError) {
        logger.error({ category: err.category }, "Lucy provider call failed");
        return { ok: false, code: err.category };
      }
      throw err;
    }

    post = interactivePostCheck(raw, body.lastDraft, permittedTopicKeys);
    if (post.ok) break;

    const canRetry = attempt < MAX_ATTEMPTS && RETRYABLE_POST_CHECK_CODES.has(post.code);
    logger.warn({ code: post.code, attempt, retrying: canRetry }, "Lucy reply rejected by post-check");
    if (!canRetry) {
      return { ok: false, code: post.code };
    }
  }

  // The loop only falls through to here via `break` on post.ok — every other
  // path returns early — but TS can't see that across the loop, so assert it.
  if (!post?.ok) {
    throw new Error("unreachable: post-check loop exited without an ok result");
  }
  const result = post.result;
  let link: string | null = null;
  let finalReply = result.reply;

  if (result.action === "send_form") {
    const minted = await createIntakeLink(personId, result.promoOffered ? "first_month_20" : "none");
    link = minted.url;
    finalReply = result.reply ? `${result.reply} ${link}` : link;
  }

  return {
    ok: true,
    action: result.action,
    reply: finalReply,
    nextQuestion: result.nextQuestion,
    link,
    objectionStage: result.objectionStage,
    linkProvided: link !== null ? true : result.linkProvided,
    promoOffered: result.promoOffered,
    inboundSentiment: result.inboundSentiment,
    requiresStaff: result.requiresStaff,
    knowledgeTopicsUsed: result.knowledgeTopicsUsed,
    validatedSlotUpdates: post.validatedSlotUpdates,
    source: "model",
  };
}
