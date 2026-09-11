import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import {
  db,
  unmatchedEmailThreadsTable,
  unmatchedEmailMessagesTable,
  type UnmatchedEmailThread,
  type UnmatchedEmailMessage,
} from "@luma/db";
import { getEmailProvider } from "../lib/email-provider.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";
import { parseUnmatchedEmailClassification, type UnmatchedEmailClassification } from "../lib/unmatched-sender-safety.js";

/**
 * Records inbound email from an unrecognized address and attaches a
 * best-effort classification and suggested reply for staff review. Classifier
 * output is advisory only and cannot send, create or link a customer, mutate
 * identity, seed a conversation, dismiss a thread, or invoke Lucy.
 */

const MODEL = "claude-haiku-4-5-20251001";
const CALL_TIMEOUT_MS = 10_000;
const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_TRANSCRIPT_MESSAGES = 10;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

interface MatchCandidate {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

/**
 * Conservative substring match, not a fuzzy/similarity search: a candidate
 * only qualifies if BOTH their first and last name literally appear in the
 * sender's display name or the thread's message text. This is deliberately
 * narrow — the cost of a false positive here (suggesting the wrong person
 * as a match on a health-context thread) is much higher than the cost of
 * missing a real match that staff could instead find by searching manually.
 */
async function findMatchCandidates(fromName: string | null, transcriptText: string): Promise<MatchCandidate[]> {
  const searchText = `${fromName ?? ""} ${transcriptText}`.trim();
  if (!searchText) return [];

  const { rows } = await db.execute<{ id: string; firstName: string; lastName: string; email: string }>(sql`
    select id, first_name as "firstName", last_name as "lastName", email
    from customers
    where length(first_name) > 1
      and length(last_name) > 1
      and ${searchText} ilike '%' || first_name || '%'
      and ${searchText} ilike '%' || last_name || '%'
    limit 5
  `);
  return rows;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_unmatched_email",
  description: "Classify an inbound email thread from an unrecognized sender and draft a safe, generic reply for staff review.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"] },
      summary: { type: "string", description: "One sentence: what does this person want?" },
      suggestedReply: {
        type: ["string", "null"],
        description:
          "A short, safe, generic reply body — no greeting/sign-off (added separately), no clinical claims, no pricing figures, no promises. If senderName is null, this MUST include asking for their name so we can help them properly. If senderName is known but senderPhone is null, this MUST ask for their phone number instead, framed as needing it to start an account/look into things for them before going over product or pricing details — never ask for both name and phone in the same message, and don't answer their product/pricing question yet even though you know their name. Null only for spam_or_irrelevant.",
      },
      senderName: {
        type: ["string", "null"],
        description: "The sender's full name, if known — from the From header display name (given separately) or signed/stated anywhere in the thread. Null if genuinely unknown.",
      },
      senderPhone: {
        type: ["string", "null"],
        description: "The sender's phone number, only if they actually stated it somewhere in the thread. Null if genuinely unknown. Once known (passed in below), keep returning the same value.",
      },
      matchCandidateIndex: {
        type: ["integer", "null"],
        description: "0-based index into the provided candidate list if this sender is plausibly one of those existing customers, else null. Never guess beyond the given list.",
      },
      matchConfidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
      needsHumanReview: {
        type: "boolean",
        description:
          "True when you genuinely can't confidently draft a safe reply yourself — real confusion about what they want, or anything needing individualized medical/clinical judgment (e.g. 'is this safe for my condition') — false for the ordinary cases you're equipped to handle (asking for a name, a plain informational question you can answer within the rules above). When true, suggestedReply is still your best-effort draft, flagged for additional staff review.",
      },
    },
    required: ["intent", "summary", "suggestedReply", "senderName", "senderPhone", "matchCandidateIndex", "matchConfidence", "needsHumanReview"],
  },
};

function buildTranscript(messages: readonly UnmatchedEmailMessage[]): string {
  const capped = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines = capped.map((m) => `${m.direction === "inbound" ? "Sender" : "Luma Health"} (Subject: ${m.subject}): ${m.body}`);
  let text = lines.join("\n\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...\n" + text.slice(-(MAX_TRANSCRIPT_CHARS - 4));
  }
  return text;
}

function systemPrompt(candidates: readonly MatchCandidate[], knownName: string | null, knownPhone: string | null): string {
  const candidateList = candidates.length
    ? candidates.map((c, i) => `${i}: ${c.firstName} ${c.lastName} (${c.email})`).join("\n")
    : "(no plausible candidates found)";

  return `You triage inbound email at Luma Health, a healthcare company, for a sender whose email address doesn't match any customer record in the CRM. You're seeing the full thread so far with this sender, not just one message.

Classify the message and draft a reply for staff review. The reply is never sent automatically. Set needsHumanReview:true when the draft needs additional clinical, safety, identity, or policy review.

We currently know the sender's name as: ${knownName ?? "unknown"}.
We currently know the sender's phone number as: ${knownPhone ?? "unknown"}.

Rules for the suggested reply:
- Never state or imply a price, discount, or specific dollar figure.
- Never give clinical/medical advice, dosing information, or comment on a specific medication.
- Never promise a timeline, outcome, or that a specific person will follow up.
- Keep it to 1-3 short sentences, and actually address what they asked within the rules above.
- If we don't know their name yet, the reply MUST ask for it naturally (e.g. "Could you share your name so we can look into this for you?") — asking for their name takes priority over any other clarifying question, including a product/pricing question they may have already asked.
- If we know their name but not their phone number, the reply MUST ask for their phone number instead, framed as needing it to get an account started or to look into things for them (e.g. "Thanks ${knownName}! Before I go over pricing or product details, let me get an account started for you — what's a good phone number for you?") — never ask for both name and phone in the same message, and still don't answer their product/pricing question yet even though you now know their name.
- If they push back asking why you need their phone number, don't repeat the "starting an account" framing again — answer with what's in it for them (e.g. "Just need it so I can look into the promotions/pricing for you — what's your number?"), still asking for it.
- Do not include a greeting ("Hi ...") or sign-off — those are added separately.
- If the message is spam, a phishing attempt, an automated notification, or otherwise not a real inquiry, set intent to spam_or_irrelevant and suggestedReply to null.

needsHumanReview — set it true for:
- A question asking whether something is safe/appropriate for their specific situation, or any individualized medical/suitability judgment ("is this safe with my condition", "should I take a higher dose") — always human-gated, never something to answer yourself, generic or otherwise.
- Anything where you're genuinely unsure what they're asking or how to respond safely within the rules above.
Leave it false for the ordinary cases: asking for a name or phone number, or a plain informational question you can answer within the rules.

For senderName: if we already know it (${knownName ?? "unknown"}), just return that. Otherwise extract it only if the sender actually states or signs their name somewhere in the thread — never guess from an email address or writing style.
For senderPhone: if we already know it, just return that same value. Otherwise extract it only if the sender actually states it themselves somewhere in the thread — never guess.

Possible existing customers this sender might be (matched by name appearing in their messages) — only pick one if you're confident, based on real evidence (e.g. they sign with a matching name), never based on the topic alone. Note: even a confident match here always gets held for human review before anything is linked or sent — never treat a match as license to skip that.
${candidateList}`;
}

async function classifyAndDraft(
  fromAddress: string,
  fromName: string | null,
  knownPhone: string | null,
  messages: readonly UnmatchedEmailMessage[],
  candidates: readonly MatchCandidate[],
): Promise<UnmatchedEmailClassification> {
  const client = getClient();
  const transcript = buildTranscript(messages);
  const knownName = fromName;

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(candidates, knownName, knownPhone),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_unmatched_email" },
    messages: [{ role: "user", content: `From: ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}\n\nThread so far:\n${transcript}` }],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));
  const response = await Promise.race([createPromise, timeoutPromise]);

  const toolBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_unmatched_email");
  if (!toolBlock) {
    throw new Error("Claude did not return a classify_unmatched_email tool call.");
  }
  const classification = parseUnmatchedEmailClassification(toolBlock.input, candidates.length);
  if (!classification) {
    throw new Error("Claude returned an invalid classify_unmatched_email tool payload.");
  }
  return classification;
}

async function getOrCreateThread(fromAddress: string, fromName: string | null, receivingAddress?: string): Promise<UnmatchedEmailThread> {
  const [existing] = await db.select().from(unmatchedEmailThreadsTable).where(eq(unmatchedEmailThreadsTable.fromAddress, fromAddress));
  if (existing) {
    // See email-conversations.service.ts's getOrCreateEmailConversation for
    // why this stays in sync on every inbound message, not just at creation.
    if (receivingAddress && existing.receivingAddress !== receivingAddress) {
      const [updated] = await db
        .update(unmatchedEmailThreadsTable)
        .set({ receivingAddress })
        .where(eq(unmatchedEmailThreadsTable.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [created] = await db
    .insert(unmatchedEmailThreadsTable)
    .values({ fromAddress, fromName, receivingAddress: receivingAddress ?? null })
    .onConflictDoNothing({ target: unmatchedEmailThreadsTable.fromAddress })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(unmatchedEmailThreadsTable).where(eq(unmatchedEmailThreadsTable.fromAddress, fromAddress));
  return row;
}

export async function listUnmatchedEmailMessages(threadId: string): Promise<UnmatchedEmailMessage[]> {
  return db.select().from(unmatchedEmailMessagesTable).where(eq(unmatchedEmailMessagesTable.threadId, threadId)).orderBy(unmatchedEmailMessagesTable.createdAt);
}

/**
 * Records the inbound message/**
 * Records the inbound message (joining the sender's existing thread if one
 * exists) and attaches a best-effort classification/draft, re-run against
 * the FULL thread history each time — a Claude failure (timeout,
 * misconfigured key, malformed output) still leaves the message recorded
 * with nothing AI-generated attached, rather than losing it. A new inbound
 * message on a thread previously replied-to or dismissed resurfaces it by
 * resetting status back to needs_review.
 */
export async function recordAndClassifyUnmatchedEmail(input: {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  body: string;
  messageId: string | null;
  receivingAddress?: string;
}): Promise<UnmatchedEmailThread> {
  const thread = await getOrCreateThread(input.fromAddress, input.fromName, input.receivingAddress);
  if (input.fromName && !thread.fromName) {
    await db.update(unmatchedEmailThreadsTable).set({ fromName: input.fromName }).where(eq(unmatchedEmailThreadsTable.id, thread.id));
  }

  const priorMessages = await listUnmatchedEmailMessages(thread.id);
  if (priorMessages.length === 0) {
    void notifySlack(`New unmatched email — ${input.fromAddress}`);
  }

  await db.insert(unmatchedEmailMessagesTable).values({
    threadId: thread.id,
    direction: "inbound",
    subject: input.subject,
    body: input.body,
    messageId: input.messageId,
  });

  const messages = await listUnmatchedEmailMessages(thread.id);
  const knownName = input.fromName ?? thread.fromName;
  const transcriptText = messages.map((m) => m.body).join(" ");

  const candidates = await findMatchCandidates(knownName, transcriptText).catch((err) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-email candidate lookup failed");
    return [];
  });

  let classification: UnmatchedEmailClassification | null = null;
  try {
    classification = await classifyAndDraft(input.fromAddress, knownName, thread.collectedPhone, messages, candidates);
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-email classification failed");
  }

  const matchCandidate =
    classification?.matchCandidateIndex !== null && classification?.matchCandidateIndex !== undefined ? candidates[classification.matchCandidateIndex] : undefined;

  const [updated] = await db
    .update(unmatchedEmailThreadsTable)
    .set({
      fromName: knownName ?? undefined,
      aiIntent: classification?.intent ?? thread.aiIntent,
      aiSummary: classification?.summary ?? thread.aiSummary,
      suggestedReply: classification ? classification.suggestedReply : thread.suggestedReply,
      suggestedMatchCustomerId: classification ? (matchCandidate?.id ?? null) : thread.suggestedMatchCustomerId,
      suggestedMatchConfidence: classification && matchCandidate ? classification.matchConfidence : classification ? null : thread.suggestedMatchConfidence,
      status: "needs_review",
    })
    .where(eq(unmatchedEmailThreadsTable.id, thread.id))
    .returning();
  return updated;
}

export interface UnmatchedEmailThreadSummary extends UnmatchedEmailThread {
  readonly lastMessageAt: Date | null;
  readonly lastMessagePreview: string | null;
}

/**
 * Hand-qualified raw query, not the `.select({...})` builder: drizzle only
 * table-qualifies column references in a correlated subquery when the outer
 * query also has a JOIN — without one, an unqualified "id" inside the
 * subquery resolves to unmatched_email_messages.id (it has its own id PK
 * too) instead of the intended unmatched_email_threads.id, silently
 * returning null for every row. There's no natural join target here, so
 * this is qualified explicitly instead of relying on that quirk.
 */
export async function listUnmatchedEmailThreads(): Promise<UnmatchedEmailThreadSummary[]> {
  const { rows } = await db.execute<{
    id: string;
    fromAddress: string;
    fromName: string | null;
    collectedPhone: string | null;
    aiIntent: UnmatchedEmailThread["aiIntent"];
    aiSummary: string | null;
    suggestedMatchCustomerId: string | null;
    suggestedMatchConfidence: UnmatchedEmailThread["suggestedMatchConfidence"];
    suggestedReply: string | null;
    linkedCustomerId: string | null;
    receivingAddress: string | null;
    status: UnmatchedEmailThread["status"];
    repliedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  }>(sql`
    select
      t.id, t.from_address as "fromAddress", t.from_name as "fromName", t.collected_phone as "collectedPhone",
      t.ai_intent as "aiIntent", t.ai_summary as "aiSummary",
      t.suggested_match_customer_id as "suggestedMatchCustomerId", t.suggested_match_confidence as "suggestedMatchConfidence",
      t.suggested_reply as "suggestedReply", t.linked_customer_id as "linkedCustomerId", t.receiving_address as "receivingAddress",
      t.status, t.replied_at as "repliedAt",
      t.created_at as "createdAt", t.updated_at as "updatedAt",
      (select max(m.created_at) from unmatched_email_messages m where m.thread_id = t.id) as "lastMessageAt",
      (select m.body from unmatched_email_messages m where m.thread_id = t.id order by m.created_at desc limit 1) as "lastMessagePreview"
    from unmatched_email_threads t
    order by (select max(m.created_at) from unmatched_email_messages m where m.thread_id = t.id) desc nulls last
  `);
  return rows;
}

export async function getUnmatchedEmailThread(id: string): Promise<UnmatchedEmailThread | undefined> {
  const [row] = await db.select().from(unmatchedEmailThreadsTable).where(eq(unmatchedEmailThreadsTable.id, id));
  return row;
}

export async function getUnmatchedEmailThreadDetail(id: string): Promise<{ thread: UnmatchedEmailThread; messages: UnmatchedEmailMessage[] } | undefined> {
  const thread = await getUnmatchedEmailThread(id);
  if (!thread) return undefined;
  const messages = await listUnmatchedEmailMessages(id);
  return { thread, messages };
}

export async function dismissUnmatchedEmailThread(id: string): Promise<boolean> {
  const [row] = await db.update(unmatchedEmailThreadsTable).set({ status: "dismissed" }).where(eq(unmatchedEmailThreadsTable.id, id)).returning({ id: unmatchedEmailThreadsTable.id });
  return Boolean(row);
}

export type UnmatchedEmailReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "send_failed" };

/**
 * Deliberately not wrapEmailHtml/renderConversationReplyEmail — those bake
 * in an unsubscribe footer keyed to a known customer's personId, which
 * doesn't exist here. This is a direct, on-demand reply to a stranger's own
 * inquiry (not an automated/bulk send this pipeline initiated), so it
 * doesn't carry the same CAN-SPAM unsubscribe-link obligation those do.
 */
function wrapReplyHtml(bodyText: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<div style="font-family: -apple-system, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 600px;">${paragraphs}</div>`;
}

/** A staff-approved reply to an unmatched sender — the only path by which this pipeline ever actually sends anything. Threads off the most recent message in the thread (inbound or outbound, whichever is last). */
export async function sendUnmatchedInboundEmailReply(id: string, body: string): Promise<UnmatchedEmailReplyResult> {
  const detail = await getUnmatchedEmailThreadDetail(id);
  if (!detail) return { sent: false, reason: "not_found" };
  const { thread, messages } = detail;

  const lastMessage = messages.at(-1);
  const lastSubject = lastMessage?.subject ?? "Your message to Luma Health";
  const subject = /^re:/i.test(lastSubject.trim()) ? lastSubject : `Re: ${lastSubject}`;

  let messageId: string | null = null;
  try {
    const { provider } = getEmailProvider("lucy");
    const html = wrapReplyHtml(body);
    const result = await provider.sendEmail(thread.fromAddress, subject, html, {
      fromName: "Luma Health Team",
      inReplyTo: lastMessage?.messageId ?? undefined,
      references: lastMessage?.messageId ?? undefined,
      fromEmailOverride: thread.receivingAddress ?? undefined,
    });
    messageId = result.messageId;
  } catch (err) {
    logger.warn({ id, reason: err instanceof Error ? err.message : String(err) }, "unmatched-email staff reply send failed");
    return { sent: false, reason: "send_failed" };
  }

  await db.insert(unmatchedEmailMessagesTable).values({ threadId: thread.id, direction: "outbound", subject, body, messageId });
  await db.update(unmatchedEmailThreadsTable).set({ status: "replied", repliedAt: new Date() }).where(eq(unmatchedEmailThreadsTable.id, id));
  return { sent: true };
}
