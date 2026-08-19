import { describe, expect, it, vi, beforeAll } from "vitest";
import { db, customersTable } from "@luma/db";
import type { SarahTurnResult } from "./sarah-conversation.service.js";
import { isCustomerEmailDnd, setCustomerEmailDnd } from "./dnd.service.js";

beforeAll(() => {
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const runSarahTurnMock = vi.fn();
vi.mock("./sarah-conversation.service.js", async () => {
  const actual = await vi.importActual<typeof import("./sarah-conversation.service.js")>("./sarah-conversation.service.js");
  return { ...actual, runSarahTurn: (...args: unknown[]) => runSarahTurnMock(...args) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Sarah at Luma Health" }) };
});

const { processInboundSupportEmail } = await import("./sarah-email-dispatch.service.js");
const { getOrCreateSupportEmailConversation, listSupportEmailMessages } = await import("./support-email-conversations.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Support", lastName: "Test", email: `support-email-dispatch-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-16" })
    .returning({ id: customersTable.id });
  return row.id;
}

function okResult(overrides: Partial<Extract<SarahTurnResult, { ok: true }>> = {}): SarahTurnResult {
  return {
    ok: true,
    action: "reply",
    reply: "Your order shipped this morning.",
    nextQuestion: "Anything else I can help with?",
    inboundSentiment: "neutral",
    requiresStaff: false,
    knowledgeTopicsUsed: [],
    source: "model",
    preCheckCode: null,
    ...overrides,
  };
}

describe("processInboundSupportEmail", () => {
  it("persists the inbound email, sends a combined reply+nextQuestion email threaded to it, and logs it", async () => {
    runSarahTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sarah-reply-1@example.com>" });
    runSarahTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    const result = await processInboundSupportEmail(personId, "Where's my order?", "Has it shipped yet?", "<sarah-inbound-1@example.com>");

    expect(result.ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, subject, html, opts] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Re: Where's my order?");
    expect(html).toContain("Your order shipped this morning.");
    expect(html).toContain("Anything else I can help with?");
    expect(opts.inReplyTo).toBe("<sarah-inbound-1@example.com>");

    const conversation = await getOrCreateSupportEmailConversation(personId);
    const messages = await listSupportEmailMessages(conversation.id);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(messages[1].messageId).toBe("<sarah-reply-1@example.com>");
  });

  it("greets the customer by first name and signs off as Sarah — Claude's draft is only the substantive reply, not a full email", async () => {
    runSarahTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sarah-reply-2@example.com>" });
    runSarahTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await processInboundSupportEmail(personId, "Where's my order?", "Has it shipped yet?", "<sarah-inbound-2@example.com>");

    const [, , html] = sendEmailMock.mock.calls[0];
    expect(html).toContain("Hi Support,");
    expect(html).toContain("Sarah at Luma Health");

    const conversation = await getOrCreateSupportEmailConversation(personId);
    const messages = await listSupportEmailMessages(conversation.id);
    expect(messages[1].body).toContain("Hi Support,");
    expect(messages[1].body).toContain("— Sarah at Luma Health");
  });

  it("sends the OPT_OUT confirmation reply, then marks the customer DND — the confirmation itself is not blocked", async () => {
    runSarahTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sarah-optout-1@example.com>" });
    runSarahTurnMock.mockResolvedValueOnce(
      okResult({
        action: "pause",
        reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help.",
        nextQuestion: null,
        source: "pre_check_block",
        preCheckCode: "OPT_OUT",
      }),
    );

    const personId = await seedCustomer();
    expect(await isCustomerEmailDnd(personId)).toBe(false);

    await processInboundSupportEmail(personId, "unsubscribe", "STOP", null);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await isCustomerEmailDnd(personId)).toBe(true);
  });

  it("does not send anything to a customer who is already do-not-disturb", async () => {
    runSarahTurnMock.mockClear();
    sendEmailMock.mockClear();
    runSarahTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    await processInboundSupportEmail(personId, "any update?", "any update on my order?", null);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send anything, but still persists the inbound message and flags for staff, when the guardrail rejects the turn", async () => {
    runSarahTurnMock.mockClear();
    sendEmailMock.mockClear();
    runSarahTurnMock.mockResolvedValueOnce({ ok: false, code: "PROHIBITED_CLINICAL" });

    const personId = await seedCustomer();
    const result = await processInboundSupportEmail(personId, "dosage", "what dosage am I on", null);

    expect(result.ok).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateSupportEmailConversation(personId);
    expect(conversation.needsAttention).toBe(true);
  });
});
