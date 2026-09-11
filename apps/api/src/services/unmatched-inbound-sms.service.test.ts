import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  customersTable,
  conversationsTable,
  supportConversationsTable,
} from "@luma/db";

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SMS_PROVIDER = "iblusend";
  process.env.IBLUSEND_API_KEY = "iblu_test_abc123";
});

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>(
    "../lib/sms-provider.js",
  );
  return {
    ...actual,
    getSmsProvider: () => ({ sendMessage: sendMessageMock }),
  };
});

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({
  notifySlack: (...args: unknown[]) => notifySlackMock(...args),
}));

const processInboundMessageMock = vi.fn();
vi.mock("./lucy-dispatch.service.js", () => ({
  processInboundMessage: (...args: unknown[]) =>
    processInboundMessageMock(...args),
}));

const processInboundSupportMessageMock = vi.fn();
vi.mock("./sarah-dispatch.service.js", () => ({
  processInboundSupportMessage: (...args: unknown[]) =>
    processInboundSupportMessageMock(...args),
}));

const {
  recordAndClassifyUnmatchedSms,
  listUnmatchedSmsThreads,
  getUnmatchedSmsThread,
  getUnmatchedSmsThreadDetail,
  dismissUnmatchedSmsThread,
  sendUnmatchedInboundSmsReply,
} = await import("./unmatched-inbound-sms.service.js");

function toolResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", name: "classify_unmatched_sms", input }],
  };
}

function classification(overrides: Record<string, unknown> = {}) {
  return {
    intent: "other",
    summary: "Unclear intent.",
    suggestedReply: "Could you tell us more?",
    senderName: null,
    senderEmail: null,
    matchCandidateIndex: null,
    matchConfidence: null,
    needsHumanReview: false,
    confirmsExistingCustomer: false,
    productCategoryMentioned: "none",
    ...overrides,
  };
}

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `+1555${String(2000000 + phoneCounter).padStart(7, "0")}`;
}

beforeEach(() => {
  createMock.mockReset();
  sendMessageMock.mockReset();
  processInboundMessageMock.mockReset();
  processInboundSupportMessageMock.mockReset();
  notifySlackMock.mockReset();
});

function expectNoAutomaticEffects() {
  expect(sendMessageMock).not.toHaveBeenCalled();
  expect(processInboundMessageMock).not.toHaveBeenCalled();
  expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
}

describe("recordAndClassifyUnmatchedSms", () => {
  it("stores a valid classification and suggested reply as staff-only advisory data", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Asking about the program.",
          suggestedReply: "Could you share your name?",
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      "Do you offer a weight loss program?",
    );

    expect(thread).toMatchObject({
      status: "needs_review",
      aiIntent: "new_lead_interest",
      aiSummary: "Asking about the program.",
      suggestedReply: "Could you share your name?",
      linkedCustomerId: null,
    });
    expectNoAutomaticEffects();
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]).toMatchObject({
      direction: "inbound",
      body: "Do you offer a weight loss program?",
    });
  });

  it("does not persist model-extracted identity fields or create a lead", async () => {
    const senderEmail = `sms-lead-${crypto.randomUUID()}@example.com`;
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Ready to start.",
          suggestedReply: "Thanks — a staff member can review this.",
          senderName: "Taylor Morgan",
          senderEmail,
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      `I'm Taylor Morgan, ${senderEmail}`,
    );

    expect(thread.status).toBe("needs_review");
    expect(thread.fromName).toBeNull();
    expect(thread.collectedEmail).toBeNull();
    expect(thread.linkedCustomerId).toBeNull();
    expect(
      await db
        .select()
        .from(customersTable)
        .where(eq(customersTable.email, senderEmail)),
    ).toHaveLength(0);
    expectNoAutomaticEffects();
  });

  it("keeps spam classifications in needs_review instead of dismissing them automatically", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "spam_or_irrelevant",
          summary: "Likely spam.",
          suggestedReply: null,
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      "click this link",
    );

    expect(thread.aiIntent).toBe("spam_or_irrelevant");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.status).toBe("needs_review");
    expectNoAutomaticEffects();
  });

  it("never acknowledges the first message or auto-sends a later suggested reply", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          summary: "First contact.",
          suggestedReply: "Could you share your name?",
        }),
      ),
    );
    const first = await recordAndClassifyUnmatchedSms(phone, "First message");

    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          summary: "Follow-up.",
          senderName: "Jordan",
          suggestedReply: "Thanks Jordan, what is your email?",
        }),
      ),
    );
    const second = await recordAndClassifyUnmatchedSms(phone, "Jordan here");

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("needs_review");
    expect(second.suggestedReply).toBe("Thanks Jordan, what is your email?");
    expectNoAutomaticEffects();
    const detail = await getUnmatchedSmsThreadDetail(first.id);
    expect(
      detail?.messages.map((message) => [message.direction, message.body]),
    ).toEqual([
      ["inbound", "First message"],
      ["inbound", "Jordan here"],
    ]);
  });

  it("keeps a real DB-verified match as a staff suggestion without linking or mutating the customer", async () => {
    const lastName = `Review${crypto.randomUUID().slice(0, 8)}`;
    const originalPhone = "+15550001111";
    const [customer] = await db
      .insert(customersTable)
      .values({
        firstName: "Riley",
        lastName,
        email: `riley-${crypto.randomUUID()}@example.com`,
        phone: originalPhone,
        leadReceivedDate: "2026-08-15",
      })
      .returning({ id: customersTable.id });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "existing_customer_support",
          summary: "Possible existing customer.",
          senderName: `Riley ${lastName}`,
          senderEmail: `riley-${crypto.randomUUID()}@example.com`,
          matchCandidateIndex: 0,
          matchConfidence: "high",
          confirmsExistingCustomer: true,
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedSms(
      phone,
      `I'm Riley ${lastName}`,
    );

    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedMatchCustomerId).toBe(customer.id);
    expect(thread.suggestedMatchConfidence).toBe("high");
    expect(thread.linkedCustomerId).toBeNull();
    const [unchanged] = await db
      .select({ phone: customersTable.phone })
      .from(customersTable)
      .where(eq(customersTable.id, customer.id));
    expect(unchanged.phone).toBe(originalPhone);
    expect(
      await db
        .select()
        .from(conversationsTable)
        .where(eq(conversationsTable.personId, customer.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(supportConversationsTable)
        .where(eq(supportConversationsTable.personId, customer.id)),
    ).toHaveLength(0);
    expectNoAutomaticEffects();
  });

  it.each([
    [
      "missing required field",
      () => {
        const value = classification();
        delete (value as Record<string, unknown>).needsHumanReview;
        return value;
      },
    ],
    ["unknown enum", () => classification({ intent: "unknown_intent" })],
    ["oversized summary", () => classification({ summary: "x".repeat(1_001) })],
    [
      "out-of-range candidate index",
      () => classification({ matchCandidateIndex: 0, matchConfidence: "high" }),
    ],
    ["unknown extra field", () => classification({ unexpected: true })],
  ])("fails closed for %s", async (_caseName, makeInput) => {
    createMock.mockResolvedValueOnce(toolResponse(makeInput()));
    const thread = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      "Please review this",
    );

    expect(thread).toMatchObject({
      status: "needs_review",
      aiIntent: null,
      aiSummary: null,
      suggestedReply: null,
      suggestedMatchCustomerId: null,
      linkedCustomerId: null,
    });
    expectNoAutomaticEffects();
    expect(
      (await getUnmatchedSmsThreadDetail(thread.id))?.messages,
    ).toHaveLength(1);
  });

  it("fails closed when the tool call is absent or the model request throws", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "not a tool result" }],
    });
    const missingTool = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      "First inbound",
    );
    expect(missingTool.status).toBe("needs_review");
    expect(missingTool.aiIntent).toBeNull();

    createMock.mockRejectedValueOnce(new Error("network error"));
    const providerFailure = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      "Second inbound",
    );
    expect(providerFailure.status).toBe("needs_review");
    expect(providerFailure.aiIntent).toBeNull();
    expectNoAutomaticEffects();
  });

  it("preserves a prior valid advisory when a later classifier payload is invalid", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          summary: "Valid advisory.",
          suggestedReply: "Staff draft.",
        }),
      ),
    );
    const first = await recordAndClassifyUnmatchedSms(phone, "First");

    createMock.mockResolvedValueOnce(
      toolResponse(classification({ summary: "x".repeat(1_001) })),
    );
    const second = await recordAndClassifyUnmatchedSms(phone, "Second");

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("needs_review");
    expect(second.aiSummary).toBe("Valid advisory.");
    expect(second.suggestedReply).toBe("Staff draft.");
    expectNoAutomaticEffects();
  });

  it("normalizes the inbound phone and alerts Slack only for the first message", async () => {
    createMock.mockResolvedValue(toolResponse(classification()));
    const first = await recordAndClassifyUnmatchedSms("5559991234", "hello");
    expect(first.fromPhone).toBe("+15559991234");
    expect(notifySlackMock).toHaveBeenCalledTimes(1);

    notifySlackMock.mockClear();
    await recordAndClassifyUnmatchedSms("5559991234", "again");
    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("resurfaces a dismissed thread when another inbound arrives", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValue(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(phone, "hello");
    await dismissUnmatchedSmsThread(thread.id);
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("dismissed");

    await recordAndClassifyUnmatchedSms(phone, "following up");
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe(
      "needs_review",
    );
  });
});

describe("read and manual-review operations", () => {
  it("lists, fetches, and manually dismisses a thread", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    const listed = (await listUnmatchedSmsThreads()).find(
      (item) => item.id === thread.id,
    );
    expect(listed?.lastMessagePreview).toBe("hello");
    expect((await getUnmatchedSmsThread(thread.id))?.fromPhone).toBe(
      thread.fromPhone,
    );
    expect(await dismissUnmatchedSmsThread(thread.id)).toBe(true);
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("dismissed");
  });

  it("preserves the authenticated staff reply workflow", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({ suggestedReply: "Staff can edit this draft." }),
      ),
    );
    const phone = uniquePhone();
    const thread = await recordAndClassifyUnmatchedSms(
      phone,
      "How much does it cost?",
    );
    expect(sendMessageMock).not.toHaveBeenCalled();

    sendMessageMock.mockResolvedValueOnce({
      providerMessageId: "msg_staff_reply",
    });
    const result = await sendUnmatchedInboundSmsReply(
      thread.id,
      "A staff-approved response.",
    );

    expect(result).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalledWith(
      phone,
      "A staff-approved response.",
    );
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.thread.status).toBe("replied");
    expect(detail?.thread.repliedAt).not.toBeNull();
    expect(detail?.messages.at(-1)).toMatchObject({
      direction: "outbound",
      body: "A staff-approved response.",
    });
  });

  it("returns not_found for an unknown staff-reply thread", async () => {
    await expect(
      sendUnmatchedInboundSmsReply(
        "00000000-0000-0000-0000-000000000000",
        "hi",
      ),
    ).resolves.toEqual({ sent: false, reason: "not_found" });
  });

  it("leaves the thread in needs_review when an authenticated staff send fails", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    sendMessageMock.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      sendUnmatchedInboundSmsReply(thread.id, "reply text"),
    ).resolves.toEqual({ sent: false, reason: "send_failed" });
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe(
      "needs_review",
    );
  });
});
