import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { db, customersTable, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable, type UnmatchedSmsThread, type UnmatchedSmsMessage } from "@luma/db";
import { getSmsProvider } from "../lib/sms-provider.js";
import { normalizePhone } from "../lib/phone.js";
import { processInboundMessage } from "./lucy-dispatch.service.js";
import { logger } from "../lib/logger.js";

/**
 * SMS twin of unmatched-inbound-email.service.ts. What used to happen to a
 * text from a phone number matching no customer record: logged and silently
 * dropped, invisible to staff (see the identical "unrecognized phone number"
 * log line this replaces in iblusend-webhook.service.ts). This records it
 * instead, grouped into one thread per phone number, with a Claude-drafted
 * classification and suggested reply attached — never auto-sent beyond the
 * one fixed first-message acknowledgment.
 *
 * The one real difference from the email version: a text never comes with
 * an email address attached, and customers.email is NOT NULL, so a lead
 * can't be auto-created off a name alone the way it can from an unmatched
 * email sender. Both a name AND an email have to be gathered from the
 * conversation first — collectedEmail on the thread holds that once
 * Claude extracts it, separately from linkedCustomerId (set once the lead
 * actually exists). Until both are known, this pipeline only ever drafts
 * suggested replies for staff to review, the same as the email version does
 * for anything past its own first-message acknowledgment.
 *
 * The moment a lead is created (name + email both known, Claude confident
 * this is a genuine prospective customer, not spam), the triggering message
 * is handed off to Lucy's real, guardrailed pipeline (processInboundMessage)
 * instead of sitting in this queue with a generic draft — same trust level
 * every other unattended lead-capture path in this app already operates at.
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
 * Same conservative substring match as unmatched-inbound-email.service.ts's
 * findMatchCandidates — a candidate only qualifies if both their first and
 * last name literally appear in what we know about this sender (their
 * texted name, if given, plus the transcript). Deliberately narrow: a false
 * positive here means suggesting the wrong person on a health-context
 * thread, worse than staff having to search manually for a real match.
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

interface Classification {
  readonly intent: "new_lead_interest" | "existing_customer_support" | "spam_or_irrelevant" | "other";
  readonly summary: string;
  readonly suggestedReply: string | null;
  readonly senderName: string | null;
  readonly senderEmail: string | null;
  readonly matchCandidateIndex: number | null;
  readonly matchConfidence: "high" | "medium" | "low" | null;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_unmatched_sms",
  description: "Classify an inbound text thread from an unrecognized phone number and draft a safe, generic suggested reply for staff to review before sending.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"] },
      summary: { type: "string", description: "One sentence: what does this person want?" },
      suggestedReply: {
        type: ["string", "null"],
        description:
          "A short, safe, generic reply — no clinical claims, no pricing figures, no promises. If senderName is null, this MUST ask for their name — do not answer any product/pricing question yet, even if they asked one. If senderName is known but senderEmail is null, this MUST ask for their email instead, framed as needing to start an account for them before going over product or pricing details (e.g. 'Before I go over pricing or product details, let me get an account started for you — what's your email?') — never ask for both name and email in the same message, and still don't answer the product/pricing question yet. Null only for spam_or_irrelevant.",
      },
      senderName: {
        type: ["string", "null"],
        description: "The sender's full name, if known — only if they actually stated or signed it somewhere in the thread. Null if genuinely unknown. Once known (passed in below), keep returning the same value.",
      },
      senderEmail: {
        type: ["string", "null"],
        description: "The sender's email address, only if they actually stated it somewhere in the thread. Null if genuinely unknown. Once known (passed in below), keep returning the same value.",
      },
      matchCandidateIndex: {
        type: ["integer", "null"],
        description: "0-based index into the provided candidate list if this sender is plausibly one of those existing customers, else null. Never guess beyond the given list.",
      },
      matchConfidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
    },
    required: ["intent", "summary", "suggestedReply", "senderName", "senderEmail", "matchCandidateIndex", "matchConfidence"],
  },
};

function buildTranscript(messages: readonly UnmatchedSmsMessage[]): string {
  const capped = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines = capped.map((m) => `${m.direction === "inbound" ? "Sender" : "Luma Health"}: ${m.body}`);
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...\n" + text.slice(-(MAX_TRANSCRIPT_CHARS - 4));
  }
  return text;
}

function systemPrompt(candidates: readonly MatchCandidate[], knownName: string | null, knownEmail: string | null): string {
  const candidateList = candidates.length
    ? candidates.map((c, i) => `${i}: ${c.firstName} ${c.lastName} (${c.email})`).join("\n")
    : "(no plausible candidates found)";

  return `You triage inbound SMS at Luma Health, a healthcare company, for a phone number that doesn't match any customer record in the CRM. You're seeing the full text thread so far with this sender, not just one message.

Classify the message and draft a short suggested reply for a staff member to review — you are never sending anything yourself, only drafting.

We currently know the sender's name as: ${knownName ?? "unknown"}.
We currently know the sender's email as: ${knownEmail ?? "unknown"}.

Rules for the suggested reply:
- Never state or imply a price, discount, or specific dollar figure.
- Never give clinical/medical advice, dosing information, or comment on a specific medication.
- Never promise a timeline, outcome, or that a specific person will follow up.
- Keep it to 1-2 short sentences, texting style (contractions, no formal tone).
- If we don't know their name yet, the reply MUST ask for it (e.g. "Hey! Could you share your name so I know who I'm chatting with?") — this takes priority over anything else, including a product/pricing question they may have already asked.
- If we know their name but not their email, the reply MUST ask for their email instead, framed as getting an account started before going over product or pricing details (e.g. "Thanks ${knownName}! Before I go over pricing or product details, let me get an account started for you — what's your email?") — never ask for both name and email in the same message, and still don't answer their product/pricing question yet even though you now know their name.
- Do not include a greeting/sign-off beyond what reads naturally in a text.
- If the message is spam, a phishing attempt, an automated notification, or otherwise not a real inquiry, set intent to spam_or_irrelevant and suggestedReply to null.

For senderName and senderEmail: if we already know them, just return those same values. Otherwise extract only what the sender actually states themselves somewhere in the thread — never guess.

Possible existing customers this sender might be (matched by name appearing in their messages) — only pick one if you're confident, based on real evidence, never based on the topic alone:
${candidateList}`;
}

async function classifyAndDraft(
  fromPhone: string,
  fromName: string | null,
  collectedEmail: string | null,
  messages: readonly UnmatchedSmsMessage[],
  candidates: readonly MatchCandidate[],
): Promise<Classification> {
  const client = getClient();
  const transcript = buildTranscript(messages);

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(candidates, fromName, collectedEmail),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_unmatched_sms" },
    messages: [{ role: "user", content: `From: ${fromPhone}\n\nThread so far:\n${transcript}` }],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));
  const response = await Promise.race([createPromise, timeoutPromise]);

  const toolBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_unmatched_sms");
  if (!toolBlock) {
    throw new Error("Claude did not return a classify_unmatched_sms tool call.");
  }
  return toolBlock.input as Classification;
}

async function getOrCreateThread(fromPhone: string): Promise<UnmatchedSmsThread> {
  const [existing] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.fromPhone, fromPhone));
  if (existing) return existing;

  const [created] = await db
    .insert(unmatchedSmsThreadsTable)
    .values({ fromPhone })
    .onConflictDoNothing({ target: unmatchedSmsThreadsTable.fromPhone })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.fromPhone, fromPhone));
  return row;
}

/** First token as firstName, remainder (if any) as lastName — customers.lastName is NOT NULL, so a single-word name gets an empty-string lastName rather than failing. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? fullName, lastName: parts.slice(1).join(" ") };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The only place this pipeline creates data unattended: a brand-new
 * customer row, never a link to an existing one (that stays human-gated via
 * suggestedMatchCustomerId, same as the email version). Only fires once we
 * have a real name AND a real-looking email, Claude is confident this is a
 * genuine prospective customer (not spam/irrelevant, not someone claiming
 * to already be a customer), and this thread hasn't already been linked.
 */
async function maybeCreateLead(
  thread: UnmatchedSmsThread,
  classification: Classification,
  matchedExisting: boolean,
): Promise<{ customerId: string; justCreated: boolean } | null> {
  if (thread.linkedCustomerId) return { customerId: thread.linkedCustomerId, justCreated: false };
  if (matchedExisting) return null;
  if (classification.intent !== "new_lead_interest") return null;

  const name = thread.fromName ?? classification.senderName;
  const email = thread.collectedEmail ?? classification.senderEmail;
  if (!name || !email || !EMAIL_RE.test(email)) return null;

  const { firstName, lastName } = splitName(name);
  const [created] = await db
    .insert(customersTable)
    .values({
      firstName,
      lastName,
      email,
      phone: thread.fromPhone,
      leadReceivedDate: new Date().toISOString().slice(0, 10),
      leadType: "SMS Inquiry",
    })
    .returning({ id: customersTable.id });

  logger.info({ threadId: thread.id, customerId: created.id }, "created a new lead from an unmatched inbound SMS");
  return { customerId: created.id, justCreated: true };
}

export async function listUnmatchedSmsMessages(threadId: string): Promise<UnmatchedSmsMessage[]> {
  return db.select().from(unmatchedSmsMessagesTable).where(eq(unmatchedSmsMessagesTable.threadId, threadId)).orderBy(unmatchedSmsMessagesTable.createdAt);
}

const ACK_VARIANTS = [
  "Hey! Thanks for reaching out to Luma Health — could you share your name so I know who I'm chatting with? Our team will follow up shortly.",
  "Hi there, thanks for texting Luma Health! What's your name so I know who I'm talking to? We'll follow up with you shortly.",
] as const;

function pickVariant(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

/**
 * The one message this pipeline sends with no review at all — a fixed,
 * content-free acknowledgment asking for a name, not Claude's substantive
 * suggestedReply. Same reasoning as sendAutoAcknowledgment in the email
 * version: it makes no claim about their actual question, so there's
 * nothing for a guardrail to get wrong. Only ever fires on a thread's first
 * message — every message after that goes through Claude's own drafted
 * (staff-reviewed) reply instead, including the "what's your email" ask.
 */
async function sendAutoAcknowledgment(threadId: string, fromPhone: string): Promise<void> {
  const body = pickVariant(ACK_VARIANTS);

  let providerMessageId: string | null = null;
  try {
    const result = await getSmsProvider().sendMessage(fromPhone, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    logger.warn({ threadId, reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms auto-acknowledgment send failed");
    return;
  }

  await db.insert(unmatchedSmsMessagesTable).values({ threadId, direction: "outbound", body, providerMessageId });
}

/**
 * Records the inbound text (joining the sender's existing thread if one
 * exists) and attaches a best-effort classification/draft, re-run against
 * the FULL thread history each time — a Claude failure (timeout,
 * misconfigured key, malformed output) still leaves the message recorded
 * with nothing AI-generated attached, rather than losing it. A new inbound
 * message on a thread previously replied-to or dismissed resurfaces it by
 * resetting status back to needs_review.
 */
export async function recordAndClassifyUnmatchedSms(fromPhone: string, body: string): Promise<UnmatchedSmsThread> {
  const normalizedPhone = normalizePhone(fromPhone);
  const thread = await getOrCreateThread(normalizedPhone);

  const priorMessages = await listUnmatchedSmsMessages(thread.id);
  const isFirstMessage = priorMessages.length === 0;

  await db.insert(unmatchedSmsMessagesTable).values({ threadId: thread.id, direction: "inbound", body });

  const messages = await listUnmatchedSmsMessages(thread.id);
  const transcriptText = messages.map((m) => m.body).join(" ");

  const candidates = await findMatchCandidates(thread.fromName, transcriptText).catch((err) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms candidate lookup failed");
    return [];
  });

  let classification: Classification | null = null;
  try {
    classification = await classifyAndDraft(normalizedPhone, thread.fromName, thread.collectedEmail, messages, candidates);
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms classification failed");
  }

  const matchCandidate =
    classification?.matchCandidateIndex !== null && classification?.matchCandidateIndex !== undefined ? candidates[classification.matchCandidateIndex] : undefined;

  const leadResult = classification ? await maybeCreateLead(thread, classification, Boolean(matchCandidate)) : null;

  if (leadResult?.justCreated) {
    // Confident enough to create the lead means confident enough to hand
    // THIS message straight to Lucy's real, guardrailed pipeline — not the
    // generic "a team member will follow up" queue. Same trust level Lucy
    // already operates at unattended for every other lead.
    try {
      await processInboundMessage(leadResult.customerId, body);
    } catch (err) {
      logger.warn({ threadId: thread.id, reason: err instanceof Error ? err.message : String(err) }, "handoff to Lucy after lead creation failed");
    }
  } else if (isFirstMessage && classification?.intent !== "spam_or_irrelevant") {
    // One immediate, fixed, content-free acknowledgment per thread — see
    // sendAutoAcknowledgment's docstring. Only on the thread's first-ever
    // message; skipped above when Lucy is about to reply live instead. Also
    // skipped for spam/irrelevant. A failed classification call
    // (classification is null) still gets the ack, same as the email
    // version — no way to know it's spam without Claude.
    await sendAutoAcknowledgment(thread.id, normalizedPhone);
  }

  const [updated] = await db
    .update(unmatchedSmsThreadsTable)
    .set({
      fromName: thread.fromName ?? classification?.senderName ?? undefined,
      collectedEmail: thread.collectedEmail ?? classification?.senderEmail ?? undefined,
      aiIntent: classification?.intent ?? thread.aiIntent,
      aiSummary: classification?.summary ?? thread.aiSummary,
      suggestedReply: leadResult?.justCreated ? null : (classification?.suggestedReply ?? thread.suggestedReply),
      suggestedMatchCustomerId: matchCandidate?.id ?? thread.suggestedMatchCustomerId,
      suggestedMatchConfidence: matchCandidate ? (classification?.matchConfidence ?? null) : thread.suggestedMatchConfidence,
      linkedCustomerId: leadResult?.customerId ?? thread.linkedCustomerId,
      status: leadResult?.justCreated ? "replied" : "needs_review",
      repliedAt: leadResult?.justCreated ? new Date() : thread.repliedAt,
    })
    .where(eq(unmatchedSmsThreadsTable.id, thread.id))
    .returning();
  return updated;
}

export interface UnmatchedSmsThreadSummary extends UnmatchedSmsThread {
  readonly lastMessageAt: Date | null;
  readonly lastMessagePreview: string | null;
}

/** Hand-qualified raw query — same reasoning as listUnmatchedEmailThreads: an unqualified "id" in a correlated subquery with no outer JOIN can silently resolve to the wrong table's id. */
export async function listUnmatchedSmsThreads(): Promise<UnmatchedSmsThreadSummary[]> {
  const { rows } = await db.execute<{
    id: string;
    fromPhone: string;
    fromName: string | null;
    collectedEmail: string | null;
    aiIntent: UnmatchedSmsThread["aiIntent"];
    aiSummary: string | null;
    suggestedMatchCustomerId: string | null;
    suggestedMatchConfidence: UnmatchedSmsThread["suggestedMatchConfidence"];
    suggestedReply: string | null;
    linkedCustomerId: string | null;
    status: UnmatchedSmsThread["status"];
    repliedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  }>(sql`
    select
      t.id, t.from_phone as "fromPhone", t.from_name as "fromName", t.collected_email as "collectedEmail",
      t.ai_intent as "aiIntent", t.ai_summary as "aiSummary",
      t.suggested_match_customer_id as "suggestedMatchCustomerId", t.suggested_match_confidence as "suggestedMatchConfidence",
      t.suggested_reply as "suggestedReply", t.linked_customer_id as "linkedCustomerId", t.status, t.replied_at as "repliedAt",
      t.created_at as "createdAt", t.updated_at as "updatedAt",
      (select max(m.created_at) from unmatched_sms_messages m where m.thread_id = t.id) as "lastMessageAt",
      (select m.body from unmatched_sms_messages m where m.thread_id = t.id order by m.created_at desc limit 1) as "lastMessagePreview"
    from unmatched_sms_threads t
    order by (select max(m.created_at) from unmatched_sms_messages m where m.thread_id = t.id) desc nulls last
  `);
  return rows;
}

export async function getUnmatchedSmsThread(id: string): Promise<UnmatchedSmsThread | undefined> {
  const [row] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.id, id));
  return row;
}

export async function getUnmatchedSmsThreadDetail(id: string): Promise<{ thread: UnmatchedSmsThread; messages: UnmatchedSmsMessage[] } | undefined> {
  const thread = await getUnmatchedSmsThread(id);
  if (!thread) return undefined;
  const messages = await listUnmatchedSmsMessages(id);
  return { thread, messages };
}

export async function dismissUnmatchedSmsThread(id: string): Promise<boolean> {
  const [row] = await db.update(unmatchedSmsThreadsTable).set({ status: "dismissed" }).where(eq(unmatchedSmsThreadsTable.id, id)).returning({ id: unmatchedSmsThreadsTable.id });
  return Boolean(row);
}

export type UnmatchedSmsReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "send_failed" };

/** A staff-approved reply to an unmatched sender — the only other path (besides the auto-ack) by which this pipeline ever sends anything. */
export async function sendUnmatchedInboundSmsReply(id: string, body: string): Promise<UnmatchedSmsReplyResult> {
  const thread = await getUnmatchedSmsThread(id);
  if (!thread) return { sent: false, reason: "not_found" };

  let providerMessageId: string | null = null;
  try {
    const result = await getSmsProvider().sendMessage(thread.fromPhone, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    logger.warn({ id, reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms staff reply send failed");
    return { sent: false, reason: "send_failed" };
  }

  await db.insert(unmatchedSmsMessagesTable).values({ threadId: thread.id, direction: "outbound", body, providerMessageId });
  await db.update(unmatchedSmsThreadsTable).set({ status: "replied", repliedAt: new Date() }).where(eq(unmatchedSmsThreadsTable.id, id));
  return { sent: true };
}
