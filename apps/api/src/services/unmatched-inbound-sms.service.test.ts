import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";

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
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

// Handoff-after-lead-creation is tested here only as "was processInboundMessage
// called with the right args" — Lucy's actual pipeline (its own Claude call,
// guardrails, sending) is covered by lucy-dispatch.service.test.ts.
const processInboundMessageMock = vi.fn();
vi.mock("./lucy-dispatch.service.js", async () => {
  const actual = await vi.importActual<typeof import("./lucy-dispatch.service.js")>("./lucy-dispatch.service.js");
  return { ...actual, processInboundMessage: (...args: unknown[]) => processInboundMessageMock(...args) };
});

const {
  recordAndClassifyUnmatchedSms,
  listUnmatchedSmsThreads,
  getUnmatchedSmsThread,
  getUnmatchedSmsThreadDetail,
  dismissUnmatchedSmsThread,
  sendUnmatchedInboundSmsReply,
} = await import("./unmatched-inbound-sms.service.js");

function toolResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name: "classify_unmatched_sms", input }] };
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

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `+1555${String(2000000 + phoneCounter).padStart(7, "0")}`;
}

beforeEach(() => {
  createMock.mockClear();
  sendMessageMock.mockClear();
  processInboundMessageMock.mockClear();
});

describe("recordAndClassifyUnmatchedSms", () => {
  it("records the text with the classification and drafted reply attached", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", summary: "Asking about weight loss programs.", suggestedReply: "Could you share your name?" })),
    );

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "Do you offer weight loss programs?");

    expect(thread.status).toBe("needs_review");
    expect(thread.aiIntent).toBe("new_lead_interest");
    expect(thread.aiSummary).toBe("Asking about weight loss programs.");
    expect(thread.suggestedReply).toBe("Could you share your name?");
    expect(thread.suggestedMatchCustomerId).toBeNull();
    // No name known yet, so no lead should have been auto-created.
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("normalizes the phone number to E.164 before storing/looking up the thread", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms("5559991234", "hi");
    expect(thread.fromPhone).toBe("+15559991234");
  });

  it("joins the same thread when a second text arrives from the same number, instead of creating a duplicate", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First message." })));
    const first = await recordAndClassifyUnmatchedSms(phone, "Question one.");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Second message, same thread." })));
    const second = await recordAndClassifyUnmatchedSms(phone, "Question two.");

    expect(second.id).toBe(first.id);
    const detail = await getUnmatchedSmsThreadDetail(first.id);
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages.map((m) => m.body)).toEqual(["Question one.", "Question two."]);

    const secondCallUserContent = createMock.mock.calls[1][0].messages[0].content as string;
    expect(secondCallUserContent).toContain("Question one.");
    expect(secondCallUserContent).toContain("Question two.");
  });

  it("resurfaces a dismissed thread (resets status to needs_review) when a new message arrives", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(phone, "hello");
    await dismissUnmatchedSmsThread(thread.id);
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("dismissed");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "They wrote again." })));
    await recordAndClassifyUnmatchedSms(phone, "following up");

    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("needs_review");
  });

  it("asks for the sender's name when unknown, per the suggested reply Claude drafts", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", suggestedReply: "Could you share your name?" })));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hi");
    expect(thread.suggestedReply).toContain("name");
  });

  it("asks for the sender's email once the name is known but the email isn't", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", senderName: "Taylor", suggestedReply: "Could you share your email?" })));
    const thread = await recordAndClassifyUnmatchedSms(phone, "It's Taylor");

    expect(thread.fromName).toBe("Taylor");
    expect(thread.collectedEmail).toBeNull();
    // Not enough to create a lead yet — email is still missing.
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedReply).toContain("email");
  });

  it("creates a new lead once both name and email are known and Claude classifies genuine new-lead interest", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Wants to start a program.",
          suggestedReply: "A team member will follow up.",
          senderName: "Taylor Morgan",
          senderEmail: "taylor.morgan@example.com",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "I'd like to learn more, I'm Taylor Morgan, taylor.morgan@example.com");

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.firstName).toBe("Taylor");
    expect(customer.lastName).toBe("Morgan");
    expect(customer.email).toBe("taylor.morgan@example.com");
    expect(customer.phone).toBe(thread.fromPhone);
    expect(customer.leadType).toBe("SMS Inquiry");

    expect(processInboundMessageMock).toHaveBeenCalledWith(thread.linkedCustomerId, "I'd like to learn more, I'm Taylor Morgan, taylor.morgan@example.com");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.repliedAt).not.toBeNull();
  });

  it("does not create a lead when the extracted email doesn't look like a real email address", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Taylor", senderEmail: "not an email" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hi");
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("does not create a lead when intent is existing_customer_support, even with a known name and email", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "existing_customer_support", summary: "Asking about an order.", senderName: "Jordan Lee", senderEmail: "jordan@example.com" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "Where is my order?");
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("does not create a lead for spam_or_irrelevant even with a known name and email", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Marketing spam.", suggestedReply: null, senderName: "Spam Bot", senderEmail: "spam@example.com" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "click here");
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedReply).toBeNull();
  });

  it("only attaches a suggested match when Claude picks a candidate from the real, DB-verified list — never an invented id, and does not create a duplicate lead", async () => {
    // A collision-free last name — this test suite shares one schema across
    // files for the whole run, and the email version's identical test seeds
    // a plain "Jamie Rivera" too, which would otherwise nondeterministically
    // match this test's own query.
    const lastName = `RiveraSms${crypto.randomUUID().slice(0, 6)}`;
    const candidateId = await seedCustomer("Jamie", lastName);
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

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), `Hi, checking on my order. Thanks, Jamie ${lastName}`);

    expect(thread.suggestedMatchCustomerId).toBe(candidateId);
    expect(thread.suggestedMatchConfidence).toBe("high");
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("still records the text with everything AI-generated left null when the Claude call fails", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "Question about your service.");

    expect(thread.status).toBe("needs_review");
    expect(thread.aiIntent).toBeNull();
    expect(thread.aiSummary).toBeNull();
    expect(thread.suggestedReply).toBeNull();
    expect(thread.linkedCustomerId).toBeNull();
  });
});

describe("auto-acknowledgment", () => {
  it("sends a fixed, name-asking acknowledgment on a thread's first message, independent of the classification result", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_1" });

    const phone = uniquePhone();
    await recordAndClassifyUnmatchedSms(phone, "Do you offer this?");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [to, body] = sendMessageMock.mock.calls[0];
    expect(to).toBe(phone);
    // Wording is randomized (see ACK_VARIANTS) — "your name" is the
    // substring common to every variant.
    expect(body).toContain("your name");
  });

  it("does NOT send a second acknowledgment when another message arrives on the same thread", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_2" });
    await recordAndClassifyUnmatchedSms(phone, "First message.");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Second.", senderName: "Jordan" })));
    sendMessageMock.mockClear();
    await recordAndClassifyUnmatchedSms(phone, "Second message.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still records the inbound message and runs classification even when the acknowledgment send fails", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Ack failed but this still worked." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("provider down"));

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    expect(thread.aiSummary).toBe("Ack failed but this still worked.");
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(1); // just the inbound message — the failed ack was never logged
    expect(detail?.messages[0].direction).toBe("inbound");
  });

  it("does not send an acknowledgment when Claude classifies the message as spam_or_irrelevant, even on the first message", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Automated notification.", suggestedReply: null })));
    sendMessageMock.mockClear();

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "click here for a prize");

    expect(thread.aiIntent).toBe("spam_or_irrelevant");
    expect(sendMessageMock).not.toHaveBeenCalled();
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(1); // just the inbound message, no ack logged
  });

  it("still sends the acknowledgment when Claude fails entirely — no way to know it's spam without a classification, so default to acknowledging", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_fallback" });

    await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe("listUnmatchedSmsThreads / getUnmatchedSmsThread / dismissUnmatchedSmsThread", () => {
  it("lists (with last-message preview), fetches by id, and dismisses", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Unclear intent." })));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    const list = await listUnmatchedSmsThreads();
    const found = list.find((t) => t.id === thread.id);
    expect(found).toBeDefined();
    expect(found?.lastMessagePreview).toBe("hello");

    const fetched = await getUnmatchedSmsThread(thread.id);
    expect(fetched?.fromPhone).toBe(thread.fromPhone);

    const dismissed = await dismissUnmatchedSmsThread(thread.id);
    expect(dismissed).toBe(true);
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("dismissed");
  });

  it("dismissUnmatchedSmsThread returns false for an unknown id", async () => {
    const result = await dismissUnmatchedSmsThread("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

describe("sendUnmatchedInboundSmsReply", () => {
  it("sends the staff-approved reply, logs it, and marks the thread replied", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", summary: "Asking about pricing." })));
    const phone = uniquePhone();
    const thread = await recordAndClassifyUnmatchedSms(phone, "How much does it cost?");

    sendMessageMock.mockClear(); // the setup call above also triggers the first-message auto-acknowledgment send
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_staff_reply" });
    const result = await sendUnmatchedInboundSmsReply(thread.id, "A team member will follow up with pricing details shortly.");

    expect(result).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [to, body] = sendMessageMock.mock.calls[0];
    expect(to).toBe(phone);
    expect(body).toBe("A team member will follow up with pricing details shortly.");

    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.thread.status).toBe("replied");
    expect(detail?.thread.repliedAt).not.toBeNull();
    expect(detail?.messages.at(-1)).toMatchObject({ direction: "outbound", body: "A team member will follow up with pricing details shortly." });
  });

  it("returns not_found for an unknown id", async () => {
    const result = await sendUnmatchedInboundSmsReply("00000000-0000-0000-0000-000000000000", "hi");
    expect(result).toEqual({ sent: false, reason: "not_found" });
  });

  it("returns send_failed and leaves status as needs_review when the send throws", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    sendMessageMock.mockRejectedValueOnce(new Error("boom"));
    const result = await sendUnmatchedInboundSmsReply(thread.id, "reply text");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("needs_review");
  });
});
