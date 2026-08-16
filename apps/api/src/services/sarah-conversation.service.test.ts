import { describe, it, expect, vi } from "vitest";
import type { SarahInteractiveResult } from "../lib/support/types.js";
import type { SarahPreviewRequestBody } from "../lib/support/types.js";

const callSarahInteractiveMock = vi.fn();
vi.mock("../lib/support/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/support/provider.js")>("../lib/support/provider.js");
  return {
    ...actual,
    callSarahInteractive: (...args: unknown[]) => callSarahInteractiveMock(...args),
  };
});

const { runSarahTurn } = await import("./sarah-conversation.service.js");

function baseBody(overrides: Partial<SarahPreviewRequestBody> = {}): SarahPreviewRequestBody {
  return {
    messages: [{ direction: "inbound", body: "Has my order shipped yet?" }],
    orderState: { prescriptionWritten: false, orderShipped: false, trackingNumber: null },
    reviewRequested: false,
    lastQuestion: null,
    pendingTopic: null,
    lastDraft: null,
    ...overrides,
  };
}

function modelResult(overrides: Partial<SarahInteractiveResult> = {}): SarahInteractiveResult {
  return {
    action: "reply",
    reply: "Your order hasn't shipped yet, the doctor is still reviewing it.",
    confidence: 0.9,
    detectedIntents: [],
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    safetyCodes: [],
    nextQuestion: "Is there anything else I can help with?",
    inboundSentiment: "neutral",
    ...overrides,
  };
}

describe("runSarahTurn", () => {
  it("short-circuits on a pre-check block without ever calling the provider", async () => {
    callSarahInteractiveMock.mockClear();
    const result = await runSarahTurn(baseBody({ messages: [{ direction: "inbound", body: "STOP" }] }));

    expect(callSarahInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("pause");
      expect(result.source).toBe("pre_check_block");
    }
  });

  it("routes a prescription question to staff_review via pre-check, no provider call", async () => {
    callSarahInteractiveMock.mockClear();
    const result = await runSarahTurn(baseBody({ messages: [{ direction: "inbound", body: "what dosage am I on" }] }));

    expect(callSarahInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
    }
  });

  it("fails closed with the guardrail's rejection code when post-check rejects the model's reply", async () => {
    callSarahInteractiveMock.mockClear();
    callSarahInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "Your semaglutide dose is being increased." }));
    const result = await runSarahTurn(baseBody());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROHIBITED_CLINICAL");
  });

  it("retries once on a format-only rejection (MISSING_NEXT_QUESTION) and succeeds on the second attempt", async () => {
    callSarahInteractiveMock.mockClear();
    callSarahInteractiveMock
      .mockResolvedValueOnce(modelResult({ nextQuestion: null }))
      .mockResolvedValueOnce(modelResult({ nextQuestion: "Anything else I can help with?" }));
    const result = await runSarahTurn(baseBody());

    expect(callSarahInteractiveMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextQuestion).toBe("Anything else I can help with?");
  });

  it("does not retry a safety-relevant rejection", async () => {
    callSarahInteractiveMock.mockClear();
    callSarahInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "Side effects are common." }));
    const result = await runSarahTurn(baseBody());

    expect(callSarahInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROHIBITED_CLINICAL");
  });

  it("passes through action=staff_review and requiresStaff from the model", async () => {
    callSarahInteractiveMock.mockClear();
    callSarahInteractiveMock.mockResolvedValueOnce(
      modelResult({ action: "staff_review", reply: null, nextQuestion: null, requiresStaff: true }),
    );
    const result = await runSarahTurn(baseBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
    }
  });
});
