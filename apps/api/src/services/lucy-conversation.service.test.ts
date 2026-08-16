import { describe, it, expect, vi, beforeAll } from "vitest";
import { db, customersTable } from "@luma/db";
import type { ClaudeInteractiveResult, BotPreviewRequestBody } from "../lib/messaging/types.js";

beforeAll(() => {
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const callClaudeInteractiveMock = vi.fn();
vi.mock("../lib/messaging/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/messaging/provider.js")>("../lib/messaging/provider.js");
  return {
    ...actual,
    callClaudeInteractive: (...args: unknown[]) => callClaudeInteractiveMock(...args),
  };
});

const { runLucyTurn } = await import("./lucy-conversation.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Lucy", lastName: "Test", email: `lucy-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

function baseBody(overrides: Partial<BotPreviewRequestBody> = {}): BotPreviewRequestBody {
  return {
    messages: [{ direction: "inbound", body: "Hi, I'm interested in learning more." }],
    currentSlots: {
      selectedProduct: null,
      currentlyTaking: null,
      wantsProcessExplanation: null,
      hasTimeForIntake: null,
      wantsPlanInclusions: null,
      readyForForm: null,
    },
    lastQuestion: null,
    pendingTopic: null,
    lastDraft: null,
    objectionStage: 0,
    linkProvided: false,
    promoOffered: false,
    ...overrides,
  };
}

function modelResult(overrides: Partial<ClaudeInteractiveResult> = {}): ClaudeInteractiveResult {
  return {
    action: "reply",
    reply: "We offer semaglutide and tirzepatide.",
    confidence: 0.9,
    detectedIntents: [],
    detectedIntent: "unknown",
    knowledgeTopicsUsed: ["product_comparison"],
    requiresStaff: false,
    slotUpdates: {},
    resumeTopic: null,
    safetyCodes: [],
    nextQuestion: "Which one are you leaning toward?",
    linkProvided: false,
    objectionStage: 0,
    promoOffered: false,
    ...overrides,
  };
}

describe("runLucyTurn", () => {
  it("short-circuits on a pre-check block without ever calling the provider", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runLucyTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "STOP" }] }));

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("pause");
      expect(result.reply).toMatch(/unsubscribed/i);
      expect(result.source).toBe("pre_check_block");
    }
  });

  it("routes a suitability question to staff_review via pre-check, no provider call", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runLucyTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "which one is right for me?" }] }));

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
    }
  });

  it("fails closed with the guardrail's rejection code when post-check rejects the model's reply", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "We accept insurance.", knowledgeTopicsUsed: ["insurance_payment"] }));
    const personId = await seedCustomer();
    const result = await runLucyTurn(personId, baseBody());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_PRICING_CLAIM");
  });

  it("rejects a knowledge topic the model wasn't permitted to use this turn", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ knowledgeTopicsUsed: ["some_future_unenabled_topic"] }));
    const personId = await seedCustomer();
    const result = await runLucyTurn(personId, baseBody());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_KNOWLEDGE_TOPIC");
  });

  it("mints a real per-lead intake link on action=send_form and appends it to the reply, never trusting a model-supplied URL", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(
      modelResult({ action: "send_form", reply: "Perfect, sending you the signup link now.", nextQuestion: null, knowledgeTopicsUsed: [] }),
    );
    const personId = await seedCustomer();
    const result = await runLucyTurn(personId, baseBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("send_form");
      expect(result.link).toMatch(/^http:\/\/localhost:3000\/go\/.+/);
      expect(result.reply).toContain(result.link as string);
      expect(result.linkProvided).toBe(true);
    }
  });

  it("passes through the objection stage the model reports", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ objectionStage: 1 }));
    const personId = await seedCustomer();
    const result = await runLucyTurn(personId, baseBody({ objectionStage: 0 }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.objectionStage).toBe(1);
  });
});
