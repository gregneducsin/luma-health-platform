import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
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

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

// Handoff-after-lead-creation is tested here only as "was processInboundMessage
// called with the right args" — Lucy's actual pipeline (its own Claude call,
// guardrails, sending) is covered by lucy-dispatch.service.test.ts.
const processInboundMessageMock = vi.fn();
vi.mock("./lucy-dispatch.service.js", async () => {
  const actual = await vi.importActual<typeof import("./lucy-dispatch.service.js")>("./lucy-dispatch.service.js");
  return { ...actual, processInboundMessage: (...args: unknown[]) => processInboundMessageMock(...args) };
});

const processInboundSupportMessageMock = vi.fn();
vi.mock("./sarah-dispatch.service.js", async () => {
  const actual = await vi.importActual<typeof import("./sarah-dispatch.service.js")>("./sarah-dispatch.service.js");
  return { ...actual, processInboundSupportMessage: (...args: unknown[]) => processInboundSupportMessageMock(...args) };
});

const notifySnapmePriorityCodeReceivedMock = vi.fn();
vi.mock("../lib/snapme-webhook.js", () => ({ notifySnapmePriorityCodeReceived: (...args: unknown[]) => notifySnapmePriorityCodeReceivedMock(...args) }));

const {
  recordAndClassifyUnmatchedSms,
  listUnmatchedSmsThreads,
  getUnmatchedSmsThread,
  getUnmatchedSmsThreadDetail,
  dismissUnmatchedSmsThread,
  sendUnmatchedInboundSmsReply,
  sweepUnmatchedSmsFollowUps,
} = await import("./unmatched-inbound-sms.service.js");

/** Backdates a thread's updated_at past the 24-hour follow-up window — drizzle's own .set() would just re-stamp it via $onUpdate, so this goes around it with raw SQL. */
async function backdateThreadUpdatedAt(threadId: string, hoursAgo: number): Promise<void> {
  await db.execute(sql`update unmatched_sms_threads set updated_at = now() - make_interval(hours => ${hoursAgo}) where id = ${threadId}`);
}

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
    needsHumanReview: false,
    confirmsExistingCustomer: false,
    productCategoryMentioned: "none",
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
  processInboundSupportMessageMock.mockClear();
  notifySlackMock.mockClear();
  notifySnapmePriorityCodeReceivedMock.mockClear();
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

  it("grounds the triage model in what Luma actually sells, so it can't invent services when asked what the business offers", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    await recordAndClassifyUnmatchedSms(uniquePhone(), "what does luma health offer?");

    const systemPromptArg = createMock.mock.calls[0][0].system as string;
    expect(systemPromptArg).toContain("semaglutide");
    expect(systemPromptArg).toContain("tirzepatide");
    expect(systemPromptArg).toContain("Never invent services, product categories, or business");
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

  it("alerts Slack on the first message from a new unmatched number, but not on a second message in the same thread", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification()));
    await recordAndClassifyUnmatchedSms(phone, "hi");
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/New unmatched SMS/);

    notifySlackMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    await recordAndClassifyUnmatchedSms(phone, "second message");
    expect(notifySlackMock).not.toHaveBeenCalled();
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

    // Handed off as a Meta-lead-style conversation, not abandoned_cart — see
    // recordAndClassifyUnmatchedSms's comment on the leadResult branch.
    expect(processInboundMessageMock).toHaveBeenCalledWith(thread.linkedCustomerId, "I'd like to learn more, I'm Taylor Morgan, taylor.morgan@example.com", "meta_form");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.repliedAt).not.toBeNull();
  });

  it("tags the lead as DTC instead of SMS Inquiry when the thread mentions a promo code — the Facebook/Meta \"text us directly\" ad variant", async () => {
    // A collision-free name — see the neighboring "only attaches a
    // suggested match..." test's comment for why a plain common name
    // nondeterministically matches other tests' own candidate searches in
    // this shared-schema suite.
    const lastName = `DtcLead${crypto.randomUUID().slice(0, 6)}`;
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Wants to claim a promo offer.",
          suggestedReply: "Could you share your name and email so we can get you set up?",
          senderName: `Jamie ${lastName}`,
          senderEmail: `jamie.${lastName.toLowerCase()}@example.com`,
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(
      phone,
      `hey- id like to claim your fall offer for glp-1 my promo code is 44hh45, I'm Jamie ${lastName}, jamie.${lastName.toLowerCase()}@example.com`,
    );

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.leadType).toBe("DTC");

    // Fires immediately off the inbound text itself — phone + the actual
    // code value only, not the message or email — see
    // notifySnapmePriorityCodeReceived's docstring.
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledTimes(1);
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledWith(phone, "44hh45");
  });

  it("also tags the lead as DTC when the thread says \"priority code\" instead of \"promo code\" — a real production case, ads use different wording for the same thing", async () => {
    const lastName = `DtcLead${crypto.randomUUID().slice(0, 6)}`;
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Wants to claim a priority offer.",
          suggestedReply: "Could you share your name and email so we can get you set up?",
          senderName: `Siba ${lastName}`,
          senderEmail: `siba.${lastName.toLowerCase()}@example.com`,
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(
      phone,
      `Hi Luma - I'd like to check if I qualify for GLP-1. My priority code: LUMK6MF. I'm Siba ${lastName}, siba.${lastName.toLowerCase()}@example.com`,
    );

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.leadType).toBe("DTC");

    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledTimes(1);
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledWith(phone, "LUMK6MF");
  });

  it("notifies snapme.link on the turn the code actually arrives, not the later turn that creates the lead, when name and email come in across separate turns — real production case (Siba)", async () => {
    const phone = uniquePhone();
    const codeMessage = "Hi Luma - I'd like to check if I qualify for GLP-1. My priority code: LUMK6MF";
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack" }); // consumed by the first-message auto-ack
    await recordAndClassifyUnmatchedSms(phone, codeMessage); // turn 1: code only, no name/email yet — classifyAndDraft left unprimed

    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledTimes(1);
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledWith(phone, "LUMK6MF");

    createMock.mockResolvedValueOnce(toolResponse(classification({ senderName: "Siba" })));
    await recordAndClassifyUnmatchedSms(phone, "Hi this is Siba"); // turn 2: name only, no code mentioned again

    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Siba", senderEmail: "pandeysiba@gmail.com" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "pandeysiba@gmail.com"); // turn 3: email — this is the turn that actually creates the lead

    expect(thread.linkedCustomerId).not.toBeNull();
    // Still just the one notification from turn 1 — lead creation itself no
    // longer triggers a second, separate call.
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledTimes(1);
  });

  it("does not notify snapme.link for a non-DTC lead", async () => {
    const lastName = `NonDtc${crypto.randomUUID().slice(0, 6)}`;
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          senderName: `Jamie ${lastName}`,
          senderEmail: `jamie.${lastName.toLowerCase()}@example.com`,
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(
      uniquePhone(),
      `Hi, I'm interested in weight loss options. I'm Jamie ${lastName}, jamie.${lastName.toLowerCase()}@example.com`,
    );

    expect(thread.linkedCustomerId).not.toBeNull();
    expect(notifySnapmePriorityCodeReceivedMock).not.toHaveBeenCalled();
  });

  it("notifies snapme.link even when the code-bearing text never goes on to create a lead", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact, code only." })));
    const thread = await recordAndClassifyUnmatchedSms(phone, "hey what's the deal, my promo code is XZ99, is this real?");

    expect(thread.linkedCustomerId).toBeNull(); // no name/email yet — no lead created
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledTimes(1);
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledWith(phone, "XZ99");
  });

  it("does not notify snapme.link, but logs a warning, when the code phrase appears with no extractable value", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Asking about a code, no value given." })));
    await recordAndClassifyUnmatchedSms(phone, "hi, what's my promo code?");

    expect(notifySnapmePriorityCodeReceivedMock).not.toHaveBeenCalled();
  });

  it("still creates the lead once name and email are both already known, even when this turn's own intent classifies as 'other' — a real production case where a bare email address, then a plain 'thanks', both got classified as 'other' and the lead never got created", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_janelle" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "Hi"); // consumes the fixed ack

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Janelle" })));
    await recordAndClassifyUnmatchedSms(phone, "Janelle");

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Janelle" })));
    await recordAndClassifyUnmatchedSms(phone, "Weight loss");

    // The turn where the email itself arrives, classified "other" — this is
    // exactly the turn that silently failed to create a lead in production.
    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Janelle", senderEmail: "janelle@example.com" })));
    const thread = await recordAndClassifyUnmatchedSms(phone, "janelle@example.com");

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.firstName).toBe("Janelle");
    expect(customer.email).toBe("janelle@example.com");
    expect(processInboundMessageMock).toHaveBeenCalledWith(thread.linkedCustomerId, "janelle@example.com", "meta_form");
    expect(thread.status).toBe("replied");
  });

  it("seeds the new Lucy conversation with everything said before the triggering message, not just that one message", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_seed" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // consumes the fixed ack — this + the ack become "prior history"

    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          senderName: "Taylor Morgan",
          senderEmail: "taylor.morgan-seed@example.com",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "I'm Taylor Morgan, taylor.morgan-seed@example.com");

    const { getOrCreateConversation, listMessages } = await import("./conversations.service.js");
    const conversation = await getOrCreateConversation(thread.linkedCustomerId as string);
    const seeded = await listMessages(conversation.id);
    // The final triggering message is added by the real processInboundMessage
    // (mocked out in this test file), so what's asserted here is everything
    // that came BEFORE it: the "hi" and the fixed ack that answered it.
    expect(seeded.map((m) => m.body)).toEqual(["hi", expect.stringContaining("name")]);
  });

  it("does not create a lead when the extracted email doesn't look like a real email address", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Taylor", senderEmail: "not an email" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hi");
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("does not create a duplicate customer when the collected email exactly matches an existing customer's, even with no name-based match — asks a confirmation question instead of immediately parking for review", async () => {
    const existingEmail = `dana-${crypto.randomUUID()}@example.com`;
    const [existing] = await db
      .insert(customersTable)
      .values({ firstName: "Dana", lastName: "Existing", email: existingEmail, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_confirm_ask" });
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          senderName: "Someone Else", // deliberately not matching "Dana Existing" by name
          senderEmail: existingEmail,
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, `it's ${existingEmail}`);

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedMatchCustomerId).toBe(existing.id);
    expect(thread.suggestedMatchConfidence).toBe("high");
    // Auto-sent a clarifying question rather than immediately parked for a
    // person to review — see isFirstEncounterWithEmailMatch.
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toContain("different name");

    const allWithEmail = await db.select().from(customersTable).where(eq(customersTable.email, existingEmail));
    expect(allWithEmail).toHaveLength(1); // no duplicate created
  });

  it("auto-connects with no human review once the sender confirms, in a later reply, that they're the existing customer under a different name", async () => {
    const existingEmail = `pat-${crypto.randomUUID()}@example.com`;
    const [existing] = await db
      .insert(customersTable)
      .values({ firstName: "Pat", lastName: "OnFile", email: existingEmail, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    // Turn 2: gives an email that matches Pat OnFile under a different texted name — triggers the confirmation question.
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_confirm_ask" });
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Alex Nother", senderEmail: existingEmail })),
    );
    const afterAsk = await recordAndClassifyUnmatchedSms(phone, `it's ${existingEmail}`);
    expect(afterAsk.status).toBe("replied");
    expect(afterAsk.linkedCustomerId).toBeNull();

    // Turn 3: they confirm it's them.
    sendMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Alex Nother", senderEmail: existingEmail, confirmsExistingCustomer: true })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "yeah that's me, I go by Alex too");

    expect(thread.linkedCustomerId).toBe(existing.id);
    expect(thread.status).toBe("replied");
    expect(thread.suggestedMatchCustomerId).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled(); // routed into the real conversation, not a generic auto-send
    expect(processInboundMessageMock).toHaveBeenCalledWith(existing.id, "yeah that's me, I go by Alex too", "meta_form");

    const [updatedCustomer] = await db.select({ phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, existing.id));
    expect(updatedCustomer.phone).toBe(phone);

    const allWithEmail = await db.select().from(customersTable).where(eq(customersTable.email, existingEmail));
    expect(allWithEmail).toHaveLength(1); // no duplicate created
  });

  it("does not auto-connect on a confirmed identity if Claude also flags the same reply as needing human review for something else", async () => {
    const existingEmail = `jordan-${crypto.randomUUID()}@example.com`;
    const [existing] = await db
      .insert(customersTable)
      .values({ firstName: "Jordan", lastName: "OnFile", email: existingEmail, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_confirm_ask" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", senderName: "Different Name", senderEmail: existingEmail })));
    await recordAndClassifyUnmatchedSms(phone, `it's ${existingEmail}`);

    // They confirm it's them, but the same message also raises something
    // Claude flags as needing a person's attention (e.g. a suitability
    // question mixed into the same text).
    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          senderName: "Different Name",
          senderEmail: existingEmail,
          confirmsExistingCustomer: true,
          needsHumanReview: true,
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "yeah that's me, also is this safe with my heart condition?");

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.status).toBe("needs_review");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [customer] = await db.select({ phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, existing.id));
    expect(customer.phone).toBeNull(); // not touched — connection never happened
  });

  it("falls back to human review when a later reply doesn't clearly confirm the email match", async () => {
    const existingEmail = `sam-${crypto.randomUUID()}@example.com`;
    await db.insert(customersTable).values({ firstName: "Sam", lastName: "OnFile", email: existingEmail, leadReceivedDate: "2026-08-15" });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_confirm_ask" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", senderName: "Jordan Diff", senderEmail: existingEmail })));
    await recordAndClassifyUnmatchedSms(phone, `it's ${existingEmail}`);

    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Jordan Diff", senderEmail: existingEmail, confirmsExistingCustomer: false })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "no, that's not me");

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.status).toBe("needs_review");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("auto-connects with no review and no new lead when the texted name and collected email both match the same existing customer", async () => {
    const existingEmail = `riley-${crypto.randomUUID()}@example.com`;
    const [existing] = await db
      .insert(customersTable)
      .values({ firstName: "Riley", lastName: "Chen", email: existingEmail, phone: "+15550001111", leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack

    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({ intent: "new_lead_interest", senderName: "Riley Chen", senderEmail: existingEmail, matchCandidateIndex: 0, matchConfidence: "high" }),
      ),
    );
    const messageBody = `It's Riley Chen, ${existingEmail}`;
    const thread = await recordAndClassifyUnmatchedSms(phone, messageBody);

    expect(thread.linkedCustomerId).toBe(existing.id);
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.suggestedMatchCustomerId).toBeNull(); // confirmed, not left as a "possible" suggestion
    expect(sendMessageMock).not.toHaveBeenCalled(); // no generic auto-send text — routed to the real pipeline instead
    expect(processInboundMessageMock).toHaveBeenCalledWith(existing.id, messageBody, "meta_form");

    // Future texts from this number now route directly — the phone was updated.
    const [updatedCustomer] = await db.select({ phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, existing.id));
    expect(updatedCustomer.phone).toBe(phone);

    const allWithEmail = await db.select().from(customersTable).where(eq(customersTable.email, existingEmail));
    expect(allWithEmail).toHaveLength(1); // no duplicate created
  });

  it("seeds the existing customer's conversation with everything said before auto-connecting — a bare trigger message like just an email address left Lucy nothing to react to and produced total silence in production", async () => {
    const existingEmail = `jack-${crypto.randomUUID()}@example.com`;
    const [existing] = await db
      .insert(customersTable)
      .values({ firstName: "Jack", lastName: "Woodards", email: existingEmail, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_seed2" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_reply_seed2" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Jack Woodards" })));
    await recordAndClassifyUnmatchedSms(phone, "Hi I saw your promotions online");

    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Jack Woodards", senderEmail: existingEmail, matchCandidateIndex: 0, matchConfidence: "high" })),
    );
    // The kind of bare trigger message that only makes sense in context —
    // exactly the real case this test is modeled on.
    await recordAndClassifyUnmatchedSms(phone, existingEmail);

    const { getOrCreateConversation, listMessages } = await import("./conversations.service.js");
    const conversation = await getOrCreateConversation(existing.id);
    const seeded = await listMessages(conversation.id);
    expect(seeded.map((m) => m.body)).toEqual([
      "hi",
      expect.stringContaining("name"), // the fixed ack
      "Hi I saw your promotions online",
      expect.any(String), // Claude's drafted reply to that turn
    ]);
  });

  it("does not auto-connect, create a lead, or reveal a match when the collected email belongs to more than one existing customer", async () => {
    const sharedEmail = `shared-${crypto.randomUUID()}@example.com`;
    await db.insert(customersTable).values([
      { firstName: "First", lastName: "Owner", email: sharedEmail, leadReceivedDate: "2026-08-15" },
      { firstName: "Second", lastName: "Owner", email: sharedEmail, leadReceivedDate: "2026-08-15" },
    ]);

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Ambiguous Person", senderEmail: sharedEmail })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, `it's ${sharedEmail}`);

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedMatchCustomerId).toBeNull(); // can't safely point at either one
    expect(thread.status).toBe("needs_review");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled(); // no auto-sent confirmation question either — we don't know who to ask about

    const stillTwo = await db.select().from(customersTable).where(eq(customersTable.email, sharedEmail));
    expect(stillTwo).toHaveLength(2); // no third (duplicate lead) record created
  });

  it("does NOT auto-connect on a name match alone, without an agreeing email match — stays human-gated", async () => {
    const lastName = `Alone${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(customersTable).values({ firstName: "Morgan", lastName, email: `morgan-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    processInboundMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: `Morgan ${lastName}`, senderEmail: null, matchCandidateIndex: 0, matchConfidence: "medium" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, `I'm Morgan ${lastName}`);

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.status).toBe("needs_review");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not create a lead when intent is existing_customer_support, even with a known name and email — and holds the reply for human review instead of auto-sending it", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "existing_customer_support",
          summary: "Asking about an order.",
          suggestedReply: "A team member will look into your order.",
          senderName: "Jordan Lee",
          senderEmail: "jordan@example.com",
          needsHumanReview: false, // forced true anyway by intent, regardless of Claude's own flag
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "Where is my order?");
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedReply).toBe("A team member will look into your order.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still creates a DTC lead and hands off to Lucy even when Claude mislabels a promo/priority-code sender as existing_customer_support — real production cases (Glenys, Angela), who described prior GLP-1 experience and were misread as already having an account", async () => {
    const lastName = `DtcRestart${crypto.randomUUID().slice(0, 6)}`;
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          // Claude's own mistaken label — no DB match backs this up
          // (matchCandidateIndex stays null), only "I've taken a GLP-1
          // before / want to get back on it" reads as existing-customer
          // support to it. isDtcLead should override this.
          intent: "existing_customer_support",
          summary: "Wants to restart semaglutide, mentions a priority code.",
          suggestedReply: "A team member will follow up about restarting your prescription.",
          senderName: `Glenys ${lastName}`,
          senderEmail: `glenys.${lastName.toLowerCase()}@example.com`,
          needsHumanReview: false,
        }),
      ),
    );
    const message = `My priority code: LUMK6MF. I'd like to get back on semaglutide, I've taken a GLP-1 before. I'm Glenys ${lastName}, glenys.${lastName.toLowerCase()}@example.com`;
    const thread = await recordAndClassifyUnmatchedSms(phone, message);

    expect(thread.linkedCustomerId).not.toBeNull();
    expect(thread.status).toBe("replied");
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.leadType).toBe("DTC");
    expect(processInboundMessageMock).toHaveBeenCalledWith(thread.linkedCustomerId, message, "meta_form");
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledTimes(1);
    expect(notifySnapmePriorityCodeReceivedMock).toHaveBeenCalledWith(phone, "LUMK6MF");
  });

  it("holds the reply for human review when Claude sets needsHumanReview, even for an otherwise-ordinary reply", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "other", suggestedReply: "Not sure I can answer that safely.", needsHumanReview: true })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "is this safe with my heart condition?");
    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedReply).toBe("Not sure I can answer that safely.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("holds the reply for human review when Claude self-reports mentioning an out-of-scope business line, even if needsHumanReview itself is false", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "other",
          suggestedReply: "We also help clinics manage their patients.",
          needsHumanReview: false,
          productCategoryMentioned: "other_business_line",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "what does luma health offer?");
    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedReply).toBe("We also help clinics manage their patients.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("holds the reply for human review when the drafted text itself names an out-of-scope service, even when Claude's own flags say it's fine", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "other",
          suggestedReply: "We offer digital health platforms and patient engagement tools.",
          needsHumanReview: false,
          productCategoryMentioned: "none",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "what does luma health offer?");
    expect(thread.status).toBe("needs_review");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not create a lead for spam_or_irrelevant even with a known name and email, and auto-dismisses it out of the review queue", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Marketing spam.", suggestedReply: null, senderName: "Spam Bot", senderEmail: "spam@example.com" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "click here");
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedReply).toBeNull();
    expect(thread.status).toBe("dismissed");
  });

  it("only attaches a suggested match when Claude picks a candidate from the real, DB-verified list — never an invented id, and does not create a duplicate lead", async () => {
    // A collision-free last name — this test suite shares one schema across
    // files for the whole run, and the email version's identical test seeds
    // a plain "Jamie Rivera" too, which would otherwise nondeterministically
    // match this test's own query.
    const lastName = `RiveraSms${crypto.randomUUID().slice(0, 6)}`;
    const candidateId = await seedCustomer("Jamie", lastName);
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

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

    sendMessageMock.mockClear();
    const thread = await recordAndClassifyUnmatchedSms(phone, `Hi, checking on my order. Thanks, Jamie ${lastName}`);

    expect(thread.suggestedMatchCustomerId).toBe(candidateId);
    expect(thread.suggestedMatchConfidence).toBe("high");
    expect(thread.linkedCustomerId).toBeNull();
    // A plausible existing-customer match is a hard override to needs_review,
    // regardless of Claude's own needsHumanReview flag.
    expect(thread.status).toBe("needs_review");
    expect(sendMessageMock).not.toHaveBeenCalled();
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

  it("sends Claude's own drafted reply (not a repeat of the fixed ack) on a second message, since replies are auto-sent by default now", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_2" });
    await recordAndClassifyUnmatchedSms(phone, "First message.");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const firstBody = sendMessageMock.mock.calls[0][1];
    expect(firstBody).toContain("your name");

    createMock.mockResolvedValueOnce(
      toolResponse(classification({ summary: "Second.", senderName: "Jordan", suggestedReply: "Thanks Jordan! What's a good email to get you set up?" })),
    );
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_reply_2" });
    const thread = await recordAndClassifyUnmatchedSms(phone, "Second message.");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(phone, "Thanks Jordan! What's a good email to get you set up?");
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
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
    expect(thread.status).toBe("dismissed"); // auto-dismissed — an automated notification shouldn't sit in the staff review queue
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

describe("sweepUnmatchedSmsFollowUps", () => {
  it("sends a one-time nudge re-asking for a name when the thread has gone cold for 24 hours after the auto-ack — real production case (Siba, promo/priority-code DTC lead)", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack" });
    const thread = await recordAndClassifyUnmatchedSms(phone, "Hi Luma - I'd like to check if I qualify for GLP-1. My priority code: LUMK6MF");
    await backdateThreadUpdatedAt(thread.id, 25);

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_followup" });
    await sweepUnmatchedSmsFollowUps();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [to] = sendMessageMock.mock.calls[0];
    expect(to).toBe(phone);

    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.thread.followUpSentAt).not.toBeNull();
    expect(detail?.messages.at(-1)).toMatchObject({ direction: "outbound" });
  });

  it("re-asks for email instead, once the name is already known but the email never came", async () => {
    // Single turn, name extracted from this same message — the last message
    // in the thread stays the outbound ack either way, since a second turn
    // with no queued classification would otherwise leave the sender's own
    // message as the most recent one (see the "most recent is inbound" test
    // below), which the sweep must not nudge.
    createMock.mockResolvedValueOnce(toolResponse(classification({ senderName: "Siba" })));
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack" });
    const thread = await recordAndClassifyUnmatchedSms(phone, "Hi this is Siba, my promo code is 123abc");
    await backdateThreadUpdatedAt(thread.id, 25);

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_followup" });
    await sweepUnmatchedSmsFollowUps();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, body] = sendMessageMock.mock.calls[0];
    expect(body).toContain("Siba");
    expect(body.toLowerCase()).toContain("email");
  });

  it("does not nudge twice — followUpSentAt gates it to exactly one per thread", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack" });
    const thread = await recordAndClassifyUnmatchedSms(phone, "hi, my promo code is 99xyz");
    await backdateThreadUpdatedAt(thread.id, 25);

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_followup" });
    await sweepUnmatchedSmsFollowUps();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    await backdateThreadUpdatedAt(thread.id, 25);
    sendMessageMock.mockClear();
    await sweepUnmatchedSmsFollowUps();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not nudge a thread whose most recent message is inbound — the sender already replied, this isn't a cold lead", async () => {
    // Second turn's classifyAndDraft call is left unprimed (resolves to
    // undefined, caught and treated as a failed classification) so nothing
    // auto-sends in response to it — the sender's own message is left as
    // the thread's most recent one, which is exactly the case being tested.
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack" });
    await recordAndClassifyUnmatchedSms(phone, "hi, my promo code is 99xyz");
    sendMessageMock.mockClear();
    const thread = await recordAndClassifyUnmatchedSms(phone, "is this safe for my heart condition?");
    await backdateThreadUpdatedAt(thread.id, 25);

    await sweepUnmatchedSmsFollowUps();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not nudge a thread that's still within the 24-hour window", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack" });
    await recordAndClassifyUnmatchedSms(phone, "hi, my promo code is 99xyz");

    sendMessageMock.mockClear();
    await sweepUnmatchedSmsFollowUps();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
