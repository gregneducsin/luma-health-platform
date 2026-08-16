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
 * Run one turn of the Lucy conversation loop: pre-check the inbound message,
 * call Claude if it isn't blocked, post-check the response, and — on
 * action=send_form — mint the actual per-lead signup link (Claude never sees
 * or outputs a real one).
 *
 * Fails closed: any pre-check block or post-check rejection short-circuits
 * before the caller ever gets an unvalidated reply. This intentionally does
 * NOT retry or attempt automatic repair on a post-check failure — a rejected
 * turn returns `ok: false` for the caller to route to staff, not a silent
 * second guess at what Claude "meant."
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
        requiresStaff: deterministic.action === "staff_review",
        knowledgeTopicsUsed: [],
        validatedSlotUpdates: {},
        source: "pre_check_block",
      };
    }
  }

  const enabledTopics = getPreviewEnabledTopics();
  const permittedTopicKeys = new Set(enabledTopics.map((t) => t.key));

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

  const post = interactivePostCheck(raw, body.lastDraft, permittedTopicKeys);
  if (!post.ok) {
    logger.warn({ code: post.code }, "Lucy reply rejected by post-check");
    return { ok: false, code: post.code };
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
    requiresStaff: result.requiresStaff,
    knowledgeTopicsUsed: result.knowledgeTopicsUsed,
    validatedSlotUpdates: post.validatedSlotUpdates,
    source: "model",
  };
}
