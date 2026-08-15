/**
 * Types for the Claude interactive bot-preview reply.
 *
 * Deliberately free of SDK imports so this module is safe to import anywhere.
 * The Anthropic SDK must live exclusively in a provider module that is only
 * dynamically imported when all gate conditions pass.
 *
 * No database imports. No outbound messaging SDK imports.
 */

export type ClaudeInteractiveAction =
  | "reply"
  | "send_form"
  | "pause"
  | "staff_review"
  | "no_reply"
  // Legacy action names kept for backward compatibility — not used in new prompts.
  | "ask_product"
  | "explain_process"
  | "explain_pricing"
  | "explain_inclusions";

export interface ClaudeInteractiveResult {
  readonly action: ClaudeInteractiveAction;
  readonly reply: string | null;
  readonly confidence: number;
  /** Primary field — all detected intents. */
  readonly detectedIntents: readonly string[];
  /** Legacy alias — first element of detectedIntents, or "unknown". */
  readonly detectedIntent: string;
  /** Knowledge-catalog topic keys Claude cited in its response. */
  readonly knowledgeTopicsUsed: readonly string[];
  /** True when Claude flagged the turn as requiring staff review. */
  readonly requiresStaff: boolean;
  readonly slotUpdates: Record<string, unknown>;
  readonly resumeTopic: string | null;
  readonly safetyCodes: readonly string[];
  /**
   * The single follow-up question Claude appends to every action=reply message.
   * Must end with "?" and contain exactly one "?".
   * Null for action=pause, send_form, staff_review, no_reply.
   */
  readonly nextQuestion: string | null;
  /**
   * True when Claude is providing the approved intake URL in this turn's reply.
   * Set by Claude; the client tracks and forwards on subsequent turns.
   */
  readonly linkProvided: boolean;
  /**
   * True when Claude has made an objection-handling attempt in this turn.
   * Combines with the client-side frame to gate the one-attempt rule.
   */
  readonly objectionHandlingAttempted: boolean;
}

export interface BotPreviewMessage {
  readonly direction: "inbound" | "outbound";
  readonly body: string;
}

export interface BotPreviewRequestBody {
  readonly messages: readonly BotPreviewMessage[];
  readonly currentSlots: {
    readonly selectedProduct: string | null;
    readonly currentlyTaking: string | null;
    readonly wantsProcessExplanation: string | null;
    readonly hasTimeForIntake: string | null;
    readonly wantsPlanInclusions: string | null;
    readonly readyForForm: string | null;
  };
  readonly lastQuestion: string | null;
  readonly pendingTopic: string | null;
  readonly lastDraft: string | null;
  /**
   * True once Claude has already made one objection-handling attempt for a
   * soft-disinterest message in this session. When true, Claude must give
   * a single polite close (not another question) on the next disinterest turn.
   */
  readonly objectionHandlingAttempted: boolean;
  /**
   * True when the approved intake link was already provided in a previous turn.
   * Claude should not repeat the link unless the customer explicitly asks again.
   */
  readonly linkProvided: boolean;
}
