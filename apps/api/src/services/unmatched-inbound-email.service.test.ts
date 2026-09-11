import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, emailConversationsTable } from "@luma/db";

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
});

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/email-provider.js")
  >("../lib/email-provider.js");
  return {
    ...actual,
    getEmailProvider: () => ({
      provider: { sendEmail: sendEmailMock },
      fromName: "Lucy at Luma Health",
    }),
  };
});

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({
  notifySlack: (...args: unknown[]) => notifySlackMock(...args),
}));

const processInboundEmailMock = vi.fn();
vi.mock("./lucy-email-dispatch.service.js", () => ({
  processInboundEmail: (...args: unknown[]) => processInboundEmailMock(...args),
}));

const {
  recordAndClassifyUnmatchedEmail,
  listUnmatchedEmailThreads,
  getUnmatchedEmailThread,
  getUnmatchedEmailThreadDetail,
  dismissUnmatchedEmailThread,
  sendUnmatchedInboundEmailReply,
} = await import("./unmatched-inbound-email.service.js");

function toolResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", name: "classify_unmatched_email", input }],
  };
}

function classification(overrides: Record<string, unknown> = {}) {
  return {
    intent: "other",
    summary: "Unclear intent.",
    suggestedReply: "Could you tell us more?",
    senderName: null,
    senderPhone: null,
    matchCandidateIndex: null,
    matchConfidence: null,
    needsHumanReview: false,
    ...overrides,
  };
}

function uniqueAddress(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

beforeEach(() => {
  createMock.mockReset();
  sendEmailMock.mockReset();
  processInboundEmailMock.mockReset();
  notifySlackMock.mockReset();
});

function expectNoAutomaticEffects() {
  expect(sendEmailMock).not.toHaveBeenCalled();
  expect(processInboundEmailMock).not.toHaveBeenCalled();
}

describe("recordAndClassifyUnmatchedEmail", () => {
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

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("stranger"),
      fromName: null,
      subject: "Info please",
      body: "Do you offer a weight loss program?",
      messageId: "<in-1@example.com>",
    });

    expect(thread).toMatchObject({
      status: "needs_review",
      aiIntent: "new_lead_interest",
      aiSummary: "Asking about the program.",
      suggestedReply: "Could you share your name?",
      linkedCustomerId: null,
    });
    expectNoAutomaticEffects();
    const detail = await getUnmatchedEmailThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]).toMatchObject({
      direction: "inbound",
      subject: "Info please",
      body: "Do you offer a weight loss program?",
    });
  });

  it("does not persist model-extracted identity fields or create a lead", async () => {
    const fromAddress = uniqueAddress("model-lead");
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Ready to start.",
          suggestedReply: "A staff member can review this.",
          senderName: "Taylor Morgan",
          senderPhone: "555-123-9876",
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "Interested",
      body: "I'm Taylor Morgan and my number is 555-123-9876.",
      messageId: null,
    });

    expect(thread.status).toBe("needs_review");
    expect(thread.fromName).toBeNull();
    expect(thread.collectedPhone).toBeNull();
    expect(thread.linkedCustomerId).toBeNull();
    expect(
      await db
        .select()
        .from(customersTable)
        .where(eq(customersTable.email, fromAddress)),
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

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("spam"),
      fromName: "Mail Bot",
      subject: "Win now",
      body: "click this link",
      messageId: null,
    });

    expect(thread.aiIntent).toBe("spam_or_irrelevant");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.status).toBe("needs_review");
    expectNoAutomaticEffects();
  });

  it("never acknowledges the first message or auto-sends a later suggested reply", async () => {
    const fromAddress = uniqueAddress("repeat");
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          summary: "First contact.",
          suggestedReply: "Could you share your name?",
        }),
      ),
    );
    const first = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "First",
      body: "First message",
      messageId: null,
    });

    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          summary: "Follow-up.",
          senderName: "Jordan",
          suggestedReply: "Thanks Jordan, what is your phone number?",
        }),
      ),
    );
    const second = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "Second",
      body: "Jordan here",
      messageId: null,
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("needs_review");
    expect(second.suggestedReply).toBe(
      "Thanks Jordan, what is your phone number?",
    );
    expectNoAutomaticEffects();
    const detail = await getUnmatchedEmailThreadDetail(first.id);
    expect(
      detail?.messages.map((message) => [message.direction, message.body]),
    ).toEqual([
      ["inbound", "First message"],
      ["inbound", "Jordan here"],
    ]);
  });

  it("keeps a real DB-verified match as a staff suggestion without linking or seeding a conversation", async () => {
    const lastName = `Review${crypto.randomUUID().slice(0, 8)}`;
    const [customer] = await db
      .insert(customersTable)
      .values({
        firstName: "Jamie",
        lastName,
        email: uniqueAddress("existing"),
        leadReceivedDate: "2026-08-15",
      })
      .returning({ id: customersTable.id });

    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "existing_customer_support",
          summary: "Possible existing customer.",
          senderName: `Jamie ${lastName}`,
          matchCandidateIndex: 0,
          matchConfidence: "high",
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("jamie-personal"),
      fromName: null,
      subject: "Order",
      body: `Checking on my order, Jamie ${lastName}`,
      messageId: null,
    });

    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedMatchCustomerId).toBe(customer.id);
    expect(thread.suggestedMatchConfidence).toBe("high");
    expect(thread.linkedCustomerId).toBeNull();
    expect(
      await db
        .select()
        .from(emailConversationsTable)
        .where(eq(emailConversationsTable.personId, customer.id)),
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
    ["invalid phone", () => classification({ senderPhone: "call me" })],
    [
      "out-of-range candidate index",
      () => classification({ matchCandidateIndex: 0, matchConfidence: "high" }),
    ],
    ["unknown extra field", () => classification({ unexpected: true })],
  ])("fails closed for %s", async (_caseName, makeInput) => {
    createMock.mockResolvedValueOnce(toolResponse(makeInput()));
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("invalid"),
      fromName: null,
      subject: "Review",
      body: "Please review this",
      messageId: null,
    });

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
      (await getUnmatchedEmailThreadDetail(thread.id))?.messages,
    ).toHaveLength(1);
  });

  it("fails closed when the tool call is absent or the model request throws", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "not a tool result" }],
    });
    const missingTool = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("missing-tool"),
      fromName: null,
      subject: "First",
      body: "First inbound",
      messageId: null,
    });
    expect(missingTool.status).toBe("needs_review");
    expect(missingTool.aiIntent).toBeNull();

    createMock.mockRejectedValueOnce(new Error("network error"));
    const providerFailure = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("provider-failure"),
      fromName: null,
      subject: "Second",
      body: "Second inbound",
      messageId: null,
    });
    expect(providerFailure.status).toBe("needs_review");
    expect(providerFailure.aiIntent).toBeNull();
    expectNoAutomaticEffects();
  });

  it("preserves a prior valid advisory when a later classifier payload is invalid", async () => {
    const fromAddress = uniqueAddress("prior-advisory");
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          summary: "Valid advisory.",
          suggestedReply: "Staff draft.",
        }),
      ),
    );
    const first = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "First",
      body: "First",
      messageId: null,
    });

    createMock.mockResolvedValueOnce(
      toolResponse(classification({ summary: "x".repeat(1_001) })),
    );
    const second = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "Second",
      body: "Second",
      messageId: null,
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("needs_review");
    expect(second.aiSummary).toBe("Valid advisory.");
    expect(second.suggestedReply).toBe("Staff draft.");
    expectNoAutomaticEffects();
  });

  it("persists inbound mailbox metadata and alerts Slack only for the first message", async () => {
    const fromAddress = uniqueAddress("mailbox");
    createMock.mockResolvedValue(toolResponse(classification()));
    const first = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: "Casey Nguyen",
      subject: "Hello",
      body: "hello",
      messageId: "<first@example.com>",
      receivingAddress: "help@example.com",
    });
    expect(first.fromName).toBe("Casey Nguyen");
    expect(first.receivingAddress).toBe("help@example.com");
    expect(notifySlackMock).toHaveBeenCalledTimes(1);

    notifySlackMock.mockClear();
    await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: "Casey Nguyen",
      subject: "Again",
      body: "again",
      messageId: "<second@example.com>",
      receivingAddress: "help@example.com",
    });
    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("resurfaces a dismissed thread when another inbound arrives", async () => {
    const fromAddress = uniqueAddress("resurface");
    createMock.mockResolvedValue(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "Hi",
      body: "hello",
      messageId: null,
    });
    await dismissUnmatchedEmailThread(thread.id);
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe(
      "dismissed",
    );

    await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "Again",
      body: "following up",
      messageId: null,
    });
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe(
      "needs_review",
    );
  });
});

describe("read and manual-review operations", () => {
  it("lists, fetches, and manually dismisses a thread", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("list"),
      fromName: null,
      subject: "Hi",
      body: "hello",
      messageId: null,
    });

    const listed = (await listUnmatchedEmailThreads()).find(
      (item) => item.id === thread.id,
    );
    expect(listed?.lastMessagePreview).toBe("hello");
    expect((await getUnmatchedEmailThread(thread.id))?.fromAddress).toBe(
      thread.fromAddress,
    );
    expect(await dismissUnmatchedEmailThread(thread.id)).toBe(true);
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe(
      "dismissed",
    );
  });

  it("preserves the authenticated staff reply workflow and source mailbox", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({ suggestedReply: "Staff can edit this draft." }),
      ),
    );
    const fromAddress = uniqueAddress("reply");
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress,
      fromName: null,
      subject: "Question",
      body: "How much does it cost?",
      messageId: "<original@example.com>",
      receivingAddress: "help@example.com",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();

    sendEmailMock.mockResolvedValueOnce({
      messageId: "<staff-reply@example.com>",
    });
    const result = await sendUnmatchedInboundEmailReply(
      thread.id,
      "A staff-approved response.",
    );

    expect(result).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html, options] = sendEmailMock.mock.calls[0];
    expect(to).toBe(fromAddress);
    expect(subject).toBe("Re: Question");
    expect(html).toContain("A staff-approved response.");
    expect(options).toMatchObject({
      inReplyTo: "<original@example.com>",
      references: "<original@example.com>",
      fromEmailOverride: "help@example.com",
    });
    const detail = await getUnmatchedEmailThreadDetail(thread.id);
    expect(detail?.thread.status).toBe("replied");
    expect(detail?.thread.repliedAt).not.toBeNull();
    expect(detail?.messages.at(-1)).toMatchObject({
      direction: "outbound",
      subject: "Re: Question",
      body: "A staff-approved response.",
    });
  });

  it("returns not_found for an unknown staff-reply thread", async () => {
    await expect(
      sendUnmatchedInboundEmailReply(
        "00000000-0000-0000-0000-000000000000",
        "hi",
      ),
    ).resolves.toEqual({ sent: false, reason: "not_found" });
  });

  it("leaves the thread in needs_review when an authenticated staff send fails", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("send-failure"),
      fromName: null,
      subject: "Hi",
      body: "hello",
      messageId: null,
    });

    sendEmailMock.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      sendUnmatchedInboundEmailReply(thread.id, "reply text"),
    ).resolves.toEqual({ sent: false, reason: "send_failed" });
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe(
      "needs_review",
    );
  });
});
