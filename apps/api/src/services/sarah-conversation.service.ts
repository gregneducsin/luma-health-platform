import { supportPreCheck, supportPostCheck } from "../lib/support/safety.js";
import { callSarahInteractive, SarahProviderError } from "../lib/support/provider.js";
import { getSarahEnabledTopics } from "../lib/messaging/knowledge-catalog.js";
import type { SarahPreviewRequestBody, SarahInteractiveResult } from "../lib/support/types.js";
import { logger } from "../lib/logger.js";

export type SarahTurnResult =
  | {
      ok: true;
      action: SarahInteractiveResult["action"];
      reply: string | null;
      nextQuestion: string | null;
      inboundSentiment: "positive" | "neutral" | "negative" | null;
      requiresStaff: boolean;
      knowledgeTopicsUsed: readonly string[];
      source: "pre_check_block" | "model";
      preCheckCode: string | null;
    }
  | { ok: false; code: string };

/** Deterministic replies for pre-check blocks — these never reach Claude. */
const PRE_CHECK_RESULTS: Record<string, { action: "pause" | "staff_review"; reply: string | null }> = {
  OPT_OUT: { action: "pause", reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help." },
  STOP_WORD: { action: "staff_review", reply: null },
  EMERGENCY_CONTENT: {
    action: "staff_review",
    reply:
      "If this is a medical emergency, please call 911 or go to your nearest emergency room right away. This text line isn't monitored for emergencies — our team has been notified and will follow up with you.",
  },
  PRESCRIPTION_QUESTION: { action: "staff_review", reply: null },
  LEGAL_CONTENT: { action: "staff_review", reply: null },
};

/**
 * Same mechanical-vs-safety retry split as Lucy's conversation loop (see
 * lucy-conversation.service.ts's docstring) — format-only rejections get one
 * retry of the identical prompt; safety-relevant rejections never retry.
 */
const RETRYABLE_POST_CHECK_CODES = new Set(["MISSING_NEXT_QUESTION", "INVALID_NEXT_QUESTION", "UNEXPECTED_NEXT_QUESTION", "QUESTION_MARK_IN_REPLY", "REPEATED_DRAFT"]);
const MAX_ATTEMPTS = 3;

export async function runSarahTurn(body: SarahPreviewRequestBody): Promise<SarahTurnResult> {
  const lastInbound = [...body.messages].reverse().find((m) => m.direction === "inbound");
  if (lastInbound) {
    const pre = supportPreCheck(lastInbound.body);
    if (pre.blocked) {
      const deterministic = PRE_CHECK_RESULTS[pre.code] ?? { action: "staff_review" as const, reply: null };
      return {
        ok: true,
        action: deterministic.action,
        reply: deterministic.reply,
        nextQuestion: null,
        inboundSentiment: null,
        requiresStaff: deterministic.action === "staff_review",
        knowledgeTopicsUsed: [],
        source: "pre_check_block",
        preCheckCode: pre.code,
      };
    }
  }

  const enabledTopics = getSarahEnabledTopics();
  const permittedTopicKeys = new Set(enabledTopics.map((t) => t.key));

  let post: ReturnType<typeof supportPostCheck> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: SarahInteractiveResult;
    try {
      raw = await callSarahInteractive(body, enabledTopics);
    } catch (err) {
      if (err instanceof SarahProviderError) {
        logger.error({ category: err.category }, "Sarah provider call failed");
        return { ok: false, code: err.category };
      }
      throw err;
    }

    post = supportPostCheck(raw, body.lastDraft, permittedTopicKeys);
    if (post.ok) break;

    const canRetry = attempt < MAX_ATTEMPTS && RETRYABLE_POST_CHECK_CODES.has(post.code);
    logger.warn({ code: post.code, attempt, retrying: canRetry }, "Sarah reply rejected by post-check");
    if (!canRetry) {
      return { ok: false, code: post.code };
    }
  }

  if (!post?.ok) {
    throw new Error("unreachable: post-check loop exited without an ok result");
  }
  const result = post.result;

  return {
    ok: true,
    action: result.action,
    reply: result.reply,
    nextQuestion: result.nextQuestion,
    inboundSentiment: result.inboundSentiment,
    requiresStaff: result.requiresStaff,
    knowledgeTopicsUsed: result.knowledgeTopicsUsed,
    source: "model",
    preCheckCode: null,
  };
}
