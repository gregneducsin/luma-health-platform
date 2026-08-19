import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";

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
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Lucy at Luma Health" }) };
});

// Handoff-after-lead-creation is tested here only as "was processInboundEmail
// called with the right args" — Lucy's actual pipeline (its own Claude call,
// guardrails, sending) is covered by lucy-email-dispatch.service.test.ts.
const processInboundEmailMock = vi.fn();
vi.mock("./lucy-email-dispatch.service.js", async () => {
  const actual = await vi.importActual<typeof import("./lucy-email-dispatch.service.js")>("./lucy-email-dispatch.service.js");
  return { ...actual, processInboundEmail: (...args: unknown[]) => processInboundEmailMock(...args) };
});

const {
  recordAndClassifyUnmatchedEmail,
  listUnmatchedEmailThreads,
  getUnmatchedEmailThread,
  getUnmatchedEmailThreadDetail,
  dismissUnmatchedEmailThread,
  sendUnmatchedInboundEmailReply,
} = await import("./unmatched-inbound-email.service.js");

function toolResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name: "classify_unmatched_email", input }] };
}

function classification(overrides: Record<string, unknown> = {}) {
  return {
    intent: "other",
    summary: "Unclear intent.",
    suggestedReply: "Could you tell us more?",
    senderName: null,
    matchCandidateIndex: null,
    matchConfidence: null,
    ...overrides,
  };
}

async function seedCustomer(firstName: string, lastName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName, email: `${firstName}-${crypto.randomUUID()}@example.com`.toLowerCase(), leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

function uniqueAddress(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

beforeEach(() => {
  createMock.mockClear();
  sendEmailMock.mockClear();
  processInboundEmailMock.mockClear();
});

describe("recordAndClassifyUnmatchedEmail", () => {
  it("records the email with the classification and drafted reply attached", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Asking about weight loss programs.",
          suggestedReply: "Could you share your name so we can help?",
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("stranger"),
      fromName: null,
      subject: "Info please",
      body: "Do you offer weight loss programs?",
      messageId: "<in-1@example.com>",
    });

    expect(thread.status).toBe("needs_review");
    expect(thread.aiIntent).toBe("new_lead_interest");
    expect(thread.aiSummary).toBe("Asking about weight loss programs.");
    expect(thread.suggestedReply).toBe("Could you share your name so we can help?");
    expect(thread.suggestedMatchCustomerId).toBeNull();
    // No name known yet, so no lead should have been auto-created.
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("joins the same thread when a second email arrives from the same address, instead of creating a duplicate", async () => {
    const fromAddress = uniqueAddress("repeat-sender");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First message." })));
    const first = await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Hello", body: "Question one.", messageId: "<m1@example.com>" });

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Second message, same thread." })));
    const second = await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Follow up", body: "Question two.", messageId: "<m2@example.com>" });

    expect(second.id).toBe(first.id);
    const detail = await getUnmatchedEmailThreadDetail(first.id);
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages.map((m) => m.body)).toEqual(["Question one.", "Question two."]);

    // The second classification call saw the full transcript, not just the latest message.
    const secondCallSystemPrompt = createMock.mock.calls[1][0].system as string;
    expect(secondCallSystemPrompt).toContain("Possible existing customers");
    const secondCallUserContent = createMock.mock.calls[1][0].messages[0].content as string;
    expect(secondCallUserContent).toContain("Question one.");
    expect(secondCallUserContent).toContain("Question two.");
  });

  it("resurfaces a dismissed thread (resets status to needs_review) when a new message arrives", async () => {
    const fromAddress = uniqueAddress("resurface");
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Hi", body: "hello", messageId: null });
    await dismissUnmatchedEmailThread(thread.id);
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe("dismissed");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "They wrote again." })));
    await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Still there?", body: "following up", messageId: null });

    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe("needs_review");
  });

  it("asks for the sender's name when unknown, per the suggested reply Claude drafts", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "other", suggestedReply: "Could you share your name so we can look into this for you?" })),
    );
    const thread = await recordAndClassifyUnmatchedEmail({ fromAddress: uniqueAddress("noname"), fromName: null, subject: "Question", body: "hi", messageId: null });
    expect(thread.suggestedReply).toContain("name");
  });

  it("creates a new lead once the sender's name is known and Claude classifies genuine new-lead interest", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", summary: "Wants to start a program.", suggestedReply: "A team member will follow up." })),
    );
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("newlead"),
      fromName: "Taylor Morgan",
      subject: "Interested",
      body: "I'd like to learn more about your program.",
      messageId: null,
    });

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.firstName).toBe("Taylor");
    expect(customer.lastName).toBe("Morgan");
    expect(customer.email).toBe(thread.fromAddress);
    expect(customer.leadType).toBe("Email Inquiry");

    // The triggering message is handed straight to Lucy's real pipeline —
    // not left as a generic staff-reviewed draft, and no redundant generic
    // acknowledgment sent alongside it.
    expect(processInboundEmailMock).toHaveBeenCalledWith(thread.linkedCustomerId, "Interested", "I'd like to learn more about your program.", null);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.repliedAt).not.toBeNull();
  });

  it("does not create a lead when intent is existing_customer_support, even with a known name — that path is human-gated via matchCandidateIndex instead", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "existing_customer_support", summary: "Asking about an order." })));
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("support"),
      fromName: "Jordan Lee",
      subject: "Order",
      body: "Where is my order?",
      messageId: null,
    });
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("does not create a lead for spam_or_irrelevant even with a known name", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Marketing spam.", suggestedReply: null })));
    const thread = await recordAndClassifyUnmatchedEmail({ fromAddress: uniqueAddress("spam"), fromName: "Spam Bot", subject: "Win now", body: "click here", messageId: null });
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedReply).toBeNull();
  });

  it("only attaches a suggested match when Claude picks a candidate from the real, DB-verified list — never an invented id, and does not create a duplicate lead", async () => {
    const candidateId = await seedCustomer("Jamie", "Rivera");
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "existing_customer_support",
          summary: "Asking about their order status.",
          suggestedReply: "A member of our team will follow up on your order status.",
          matchCandidateIndex: 0,
          matchConfidence: "high",
        }),
      ),
    );

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("jamie-personal"),
      fromName: null,
      subject: "Order status",
      body: "Hi, checking on my order. Thanks, Jamie Rivera",
      messageId: null,
    });

    expect(thread.suggestedMatchCustomerId).toBe(candidateId);
    expect(thread.suggestedMatchConfidence).toBe("high");
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("still records the email with everything AI-generated left null when the Claude call fails", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("someone"),
      fromName: null,
      subject: "Hello",
      body: "Question about your service.",
      messageId: null,
    });

    expect(thread.status).toBe("needs_review");
    expect(thread.aiIntent).toBeNull();
    expect(thread.aiSummary).toBeNull();
    expect(thread.suggestedReply).toBeNull();
    expect(thread.linkedCustomerId).toBeNull();
  });
});

describe("auto-acknowledgment", () => {
  it("sends a fixed, name-asking acknowledgment (threaded off the inbound message) on a thread's first message, independent of the classification result", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<ack-1@example.com>" });

    const fromAddress = uniqueAddress("first-contact");
    await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Hello", body: "Do you offer this?", messageId: "<in-ack-1@example.com>" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html, opts] = sendEmailMock.mock.calls[0];
    expect(to).toBe(fromAddress);
    expect(subject).toBe("Re: Hello");
    expect(html).toContain("could you share your name");
    expect(opts.inReplyTo).toBe("<in-ack-1@example.com>");
  });

  it("sends the name-known variant (no request for a name) when the From header already carries one", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<ack-2@example.com>" });

    await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("named-sender"),
      fromName: "Casey Nguyen",
      subject: "Question",
      body: "Hi, quick question.",
      messageId: null,
    });

    const [, , html] = sendEmailMock.mock.calls[0];
    expect(html).not.toContain("share your name");
    expect(html).toContain("Thanks for reaching out");
  });

  it("does NOT send a second acknowledgment when another message arrives on the same thread", async () => {
    const fromAddress = uniqueAddress("no-double-ack");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First." })));
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<ack-3@example.com>" });
    await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Hi", body: "First message.", messageId: null });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Second." })));
    sendEmailMock.mockClear();
    await recordAndClassifyUnmatchedEmail({ fromAddress, fromName: null, subject: "Following up", body: "Second message.", messageId: null });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("still records the inbound message and runs classification even when the acknowledgment send fails", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Ack failed but this still worked." })));
    sendEmailMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("ack-fails"),
      fromName: null,
      subject: "Hi",
      body: "hello",
      messageId: null,
    });

    expect(thread.aiSummary).toBe("Ack failed but this still worked.");
    const detail = await getUnmatchedEmailThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(1); // just the inbound message — the failed ack was never logged
    expect(detail?.messages[0].direction).toBe("inbound");
  });
});

describe("listUnmatchedEmailThreads / getUnmatchedEmailThread / dismissUnmatchedEmailThread", () => {
  it("lists (with last-message preview), fetches by id, and dismisses", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Unclear intent." })));
    const thread = await recordAndClassifyUnmatchedEmail({ fromAddress: uniqueAddress("list-test"), fromName: null, subject: "Hi", body: "hello", messageId: null });

    const list = await listUnmatchedEmailThreads();
    const found = list.find((t) => t.id === thread.id);
    expect(found).toBeDefined();
    expect(found?.lastMessagePreview).toBe("hello");

    const fetched = await getUnmatchedEmailThread(thread.id);
    expect(fetched?.fromAddress).toBe(thread.fromAddress);

    const dismissed = await dismissUnmatchedEmailThread(thread.id);
    expect(dismissed).toBe(true);
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe("dismissed");
  });

  it("dismissUnmatchedEmailThread returns false for an unknown id", async () => {
    const result = await dismissUnmatchedEmailThread("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

describe("sendUnmatchedInboundEmailReply", () => {
  it("sends the staff-approved reply, threads off the most recent message, logs it, and marks the thread replied", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", summary: "Asking about pricing." })));
    const thread = await recordAndClassifyUnmatchedEmail({
      fromAddress: uniqueAddress("reply-test"),
      fromName: null,
      subject: "Question",
      body: "How much does it cost?",
      messageId: "<original-1@example.com>",
    });

    sendEmailMock.mockClear(); // the setup call above also triggers the first-message auto-acknowledgment send
    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-reply@example.com>" });
    const result = await sendUnmatchedInboundEmailReply(thread.id, "A team member will follow up with pricing details shortly.");

    expect(result).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, , opts] = sendEmailMock.mock.calls[0];
    expect(to).toBe(thread.fromAddress);
    expect(subject).toBe("Re: Question");
    expect(opts.inReplyTo).toBe("<original-1@example.com>");

    const detail = await getUnmatchedEmailThreadDetail(thread.id);
    expect(detail?.thread.status).toBe("replied");
    expect(detail?.thread.repliedAt).not.toBeNull();
    expect(detail?.messages.at(-1)).toMatchObject({ direction: "outbound", subject: "Re: Question" });
  });

  it("returns not_found for an unknown id", async () => {
    const result = await sendUnmatchedInboundEmailReply("00000000-0000-0000-0000-000000000000", "hi");
    expect(result).toEqual({ sent: false, reason: "not_found" });
  });

  it("returns send_failed and leaves status as needs_review when the send throws", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedEmail({ fromAddress: uniqueAddress("fail-test"), fromName: null, subject: "Hi", body: "hello", messageId: null });

    sendEmailMock.mockRejectedValueOnce(new Error("boom"));
    const result = await sendUnmatchedInboundEmailReply(thread.id, "reply text");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    expect((await getUnmatchedEmailThread(thread.id))?.status).toBe("needs_review");
  });
});
