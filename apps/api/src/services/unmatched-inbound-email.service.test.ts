import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
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

const {
  recordAndClassifyUnmatchedEmail,
  listUnmatchedInboundEmails,
  getUnmatchedInboundEmail,
  dismissUnmatchedInboundEmail,
  sendUnmatchedInboundEmailReply,
} = await import("./unmatched-inbound-email.service.js");

function toolResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name: "classify_unmatched_email", input }] };
}

async function seedCustomer(firstName: string, lastName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName, email: `${firstName}-${crypto.randomUUID()}@example.com`.toLowerCase(), leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

beforeEach(() => {
  createMock.mockClear();
  sendEmailMock.mockClear();
});

describe("recordAndClassifyUnmatchedEmail", () => {
  it("records the email with the classification and drafted reply attached", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse({
        intent: "new_lead_interest",
        summary: "Asking about weight loss programs.",
        suggestedReply: "Thanks for reaching out — a member of our team will follow up shortly.",
        matchCandidateIndex: null,
        matchConfidence: null,
      }),
    );

    const row = await recordAndClassifyUnmatchedEmail({
      fromAddress: "stranger@example.com",
      fromName: "A Stranger",
      subject: "Info please",
      body: "Do you offer weight loss programs?",
      messageId: "<in-1@example.com>",
    });

    expect(row.status).toBe("needs_review");
    expect(row.aiIntent).toBe("new_lead_interest");
    expect(row.aiSummary).toBe("Asking about weight loss programs.");
    expect(row.suggestedReply).toBe("Thanks for reaching out — a member of our team will follow up shortly.");
    expect(row.suggestedMatchCustomerId).toBeNull();
  });

  it("only attaches a match when Claude picks a candidate from the real, DB-verified list — never an invented id", async () => {
    const candidateId = await seedCustomer("Jamie", "Rivera");
    // Sender signs the email with a name matching the seeded customer.
    createMock.mockResolvedValueOnce(
      toolResponse({
        intent: "existing_customer_support",
        summary: "Asking about their order status.",
        suggestedReply: "A member of our team will follow up on your order status.",
        matchCandidateIndex: 0,
        matchConfidence: "high",
      }),
    );

    const row = await recordAndClassifyUnmatchedEmail({
      fromAddress: "jamie.personal@example.com",
      fromName: null,
      subject: "Order status",
      body: "Hi, checking on my order. Thanks, Jamie Rivera",
      messageId: null,
    });

    expect(row.suggestedMatchCustomerId).toBe(candidateId);
    expect(row.suggestedMatchConfidence).toBe("high");
  });

  it("sets suggestedReply to null and intent to spam_or_irrelevant when Claude classifies it as spam", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse({ intent: "spam_or_irrelevant", summary: "Automated marketing email.", suggestedReply: null, matchCandidateIndex: null, matchConfidence: null }),
    );

    const row = await recordAndClassifyUnmatchedEmail({
      fromAddress: "noreply@spam.example.com",
      fromName: null,
      subject: "You won a prize!",
      body: "Click here now.",
      messageId: null,
    });

    expect(row.aiIntent).toBe("spam_or_irrelevant");
    expect(row.suggestedReply).toBeNull();
  });

  it("still records the email with everything AI-generated left null when the Claude call fails", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));

    const row = await recordAndClassifyUnmatchedEmail({
      fromAddress: "someone@example.com",
      fromName: null,
      subject: "Hello",
      body: "Question about your service.",
      messageId: null,
    });

    expect(row.status).toBe("needs_review");
    expect(row.aiIntent).toBeNull();
    expect(row.aiSummary).toBeNull();
    expect(row.suggestedReply).toBeNull();
  });
});

describe("listUnmatchedInboundEmails / getUnmatchedInboundEmail / dismissUnmatchedInboundEmail", () => {
  it("lists, fetches by id, and dismisses", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse({ intent: "other", summary: "Unclear intent.", suggestedReply: "Could you tell us more about what you need?", matchCandidateIndex: null, matchConfidence: null }),
    );
    const row = await recordAndClassifyUnmatchedEmail({ fromAddress: "list-test@example.com", fromName: null, subject: "Hi", body: "hello", messageId: null });

    const list = await listUnmatchedInboundEmails();
    expect(list.some((r) => r.id === row.id)).toBe(true);

    const fetched = await getUnmatchedInboundEmail(row.id);
    expect(fetched?.fromAddress).toBe("list-test@example.com");

    const dismissed = await dismissUnmatchedInboundEmail(row.id);
    expect(dismissed).toBe(true);
    const afterDismiss = await getUnmatchedInboundEmail(row.id);
    expect(afterDismiss?.status).toBe("dismissed");
  });

  it("dismissUnmatchedInboundEmail returns false for an unknown id", async () => {
    const result = await dismissUnmatchedInboundEmail("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

describe("sendUnmatchedInboundEmailReply", () => {
  it("sends the staff-approved reply, threads off the original message, and marks the record replied", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse({ intent: "new_lead_interest", summary: "Asking about pricing.", suggestedReply: "A team member will follow up.", matchCandidateIndex: null, matchConfidence: null }),
    );
    const row = await recordAndClassifyUnmatchedEmail({
      fromAddress: "reply-test@example.com",
      fromName: null,
      subject: "Question",
      body: "How much does it cost?",
      messageId: "<original-1@example.com>",
    });

    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-reply@example.com>" });
    const result = await sendUnmatchedInboundEmailReply(row.id, "A team member will follow up with pricing details shortly.");

    expect(result).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, , opts] = sendEmailMock.mock.calls[0];
    expect(to).toBe("reply-test@example.com");
    expect(subject).toBe("Re: Question");
    expect(opts.inReplyTo).toBe("<original-1@example.com>");

    const after = await getUnmatchedInboundEmail(row.id);
    expect(after?.status).toBe("replied");
    expect(after?.repliedAt).not.toBeNull();
  });

  it("returns not_found for an unknown id", async () => {
    const result = await sendUnmatchedInboundEmailReply("00000000-0000-0000-0000-000000000000", "hi");
    expect(result).toEqual({ sent: false, reason: "not_found" });
  });

  it("returns send_failed and leaves status as needs_review when the send throws", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse({ intent: "other", summary: "Unclear.", suggestedReply: "Could you clarify?", matchCandidateIndex: null, matchConfidence: null }),
    );
    const row = await recordAndClassifyUnmatchedEmail({ fromAddress: "fail-test@example.com", fromName: null, subject: "Hi", body: "hello", messageId: null });

    sendEmailMock.mockRejectedValueOnce(new Error("boom"));
    const result = await sendUnmatchedInboundEmailReply(row.id, "reply text");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    const after = await getUnmatchedInboundEmail(row.id);
    expect(after?.status).toBe("needs_review");
  });
});
