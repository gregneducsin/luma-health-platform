import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { db, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable, type UnmatchedSmsThread, type UnmatchedSmsMessage } from "@luma/db";
import { getSmsProvider } from "../lib/sms-provider.js";
import { normalizePhone } from "../lib/phone.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";
import { parseUnmatchedSmsClassification, type UnmatchedSmsClassification } from "../lib/unmatched-sender-safety.js";

/**
 * Records inbound SMS from an unrecognized phone number and attaches a
 * best-effort classification and suggested reply for staff review. Classifier
 * output is advisory only and cannot send, create or link a customer, mutate
 * identity, seed a conversation, dismiss a thread, or invoke Lucy/Sarah.
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
 *
 * This is the name-based, Claude-reviewed "possibly this person" suggestion
 * shown to staff — see findExistingCustomerByEmail below for a separate,
 * deterministic exact-email check that guards lead creation directly rather
 * than relying on Claude to notice a match.
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
  name: "classify_unmatched_sms",
  description: "Classify an inbound text thread from an unrecognized phone number and draft a safe, generic reply for staff review.",
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
      needsHumanReview: {
        type: "boolean",
        description:
          "True when you genuinely can't confidently draft a safe reply yourself — real confusion about what they want, or anything needing individualized medical/clinical judgment (e.g. 'is this safe for my condition') — false for the ordinary cases you're equipped to handle (asking for a name or email, a plain informational question you can answer within the rules above). When true, suggestedReply is still your best-effort draft, flagged for additional staff review.",
      },
      confirmsExistingCustomer: {
        type: "boolean",
        description:
          "Only meaningful when told below that a prior message already asked this sender to confirm they're an existing customer under a different name. True only if their latest reply clearly confirms that (e.g. 'yes', 'that's me', gives the other name). False otherwise — including whenever that situation hasn't come up, an unclear reply, or a clear denial.",
      },
      productCategoryMentioned: {
        type: "string",
        enum: ["weight_loss_medication", "other_business_line", "none"],
        description:
          "Does suggestedReply describe, imply, or reference what Luma Health offers, does, or sells? 'weight_loss_medication' if it references the one real product (prescription semaglutide/tirzepatide via intake questionnaire). 'other_business_line' if it references or implies ANY other service, product category, or business line — software, platforms, patient engagement, practice management, consulting, staffing, or anything else — set this even if you're not fully sure it's inaccurate, since Luma doesn't offer anything beyond the medication program. 'none' if the reply doesn't describe what Luma offers at all (e.g. just asking for a name or email). Answer honestly — this is checked independently of the reply text itself.",
      },
    },
    required: [
      "intent",
      "summary",
      "suggestedReply",
      "senderName",
      "senderEmail",
      "matchCandidateIndex",
      "matchConfidence",
      "needsHumanReview",
      "confirmsExistingCustomer",
      "productCategoryMentioned",
    ],
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

function systemPrompt(candidates: readonly MatchCandidate[], knownName: string | null, knownEmail: string | null, pendingConfirmation: boolean): string {
  const candidateList = candidates.length
    ? candidates.map((c, i) => `${i}: ${c.firstName} ${c.lastName} (${c.email})`).join("\n")
    : "(no plausible candidates found)";

  const pendingConfirmationNote = pendingConfirmation
    ? `\nIMPORTANT: on a prior turn, we already asked this sender to confirm whether they go by a different name, because the email they gave matches an existing account under a different name. Read their latest reply in the thread below: if it clearly confirms that's them (e.g. "yes", "that's me", they give the other name), set confirmsExistingCustomer to true and draft a brief reply acknowledging you've found their account — do not restate or guess the name on file. If the reply is unclear or denies it, set confirmsExistingCustomer to false and continue normally (treat them as a new contact, asking for whatever's still needed).\n`
    : "";

  return `You triage inbound SMS at Luma Health, a healthcare company, for a phone number that doesn't match any customer record in the CRM. You're seeing the full text thread so far with this sender, not just one message.

Luma Health's actual product is prescription weight-loss medication —
semaglutide and tirzepatide — prescribed after a short online intake
questionnaire is reviewed by a licensed provider. That's the ONLY thing to
describe when asked what Luma Health offers, does, or sells. A real
customer was once told Luma offers "digital health platforms, patient
engagement tools, and practice management services" — none of which are
real; you invented that because nothing told you what the business
actually does. Never invent services, product categories, or business
lines beyond the one above. If asked about something outside this (e.g.
peptides, other medications, anything you're not sure Luma offers), don't
confirm or deny it either way — stay non-committal and keep moving the
conversation forward through the normal flow (name/email/handoff) instead
of answering with a guess. Set productCategoryMentioned honestly on every
turn, even when you're confident suggestedReply is fine — it's checked
independently of the reply text itself.
${pendingConfirmationNote}

Classify the message and draft a reply for staff review. The reply is never sent automatically. Set needsHumanReview:true when the draft needs additional clinical, safety, identity, or policy review.

We currently know the sender's name as: ${knownName ?? "unknown"}.
We currently know the sender's email as: ${knownEmail ?? "unknown"}.
${
  knownName && knownEmail
    ? `\nWe already have both their name and email, and the thread shows genuine interest in our products (not spam, not someone claiming to already be a customer) — that's a hot lead. Classify intent as new_lead_interest for THIS turn, even if the specific message you're looking at is just a short acknowledgment ("thanks", "ok", "cool") with no new content of its own. Judge intent from what this person is here for overall, not from the newest message in isolation — that doesn't change just because their latest reply happens to be brief. This matters more than it looks: once we have both name and email, new_lead_interest is what hands them off into a real, live sales conversation instead of leaving them stuck talking to you indefinitely, getting a generic "we'll get back to you" instead of actually being helped. Only classify something other than new_lead_interest here if they say something that genuinely changes the picture (e.g. they're actually an existing customer with a support issue, or they say they're no longer interested).\n`
    : ""
}
Rules for the suggested reply:
- Never state or imply a price, discount, or specific dollar figure.
- Never give clinical/medical advice, dosing information, or comment on a specific medication.
- Never promise a timeline, outcome, or that a specific person will follow up — including vague versions of this ("we'll get back to you soon", "someone will be in touch"). We aren't actually queuing a human follow-up here; if you're not asking for something (name/email) or answering a plain question, that's usually a sign intent should be new_lead_interest instead (see above), not a sign-off.
- Keep it to 1-2 short sentences, texting style (contractions, no formal tone).
- If we don't know their name yet, the reply MUST ask for it (e.g. "Hey! Could you share your name so I know who I'm chatting with?") — this takes priority over anything else, including a product/pricing question they may have already asked.
- If we know their name but not their email, the reply MUST ask for their email instead, framed as getting an account started before going over product or pricing details (e.g. "Thanks ${knownName}! Before I go over pricing or product details, let me get an account started for you — what's your email?") — never ask for both name and email in the same message, and still don't answer their product/pricing question yet even though you now know their name.
- If they push back on giving their email — asking why you need it (e.g. "why do you need my email"), or saying they'd rather wait/hold off — do NOT just ask for it again with different wording. Re-asking the same question three times in a row reads as nagging, not helpful, even when each version is phrased differently. On the FIRST pushback, switch to a different, low-friction question instead of repeating yourself: ask what state they're in, framed around checking what promotions/pricing are available there (e.g. "No worries! What state are you in? I can look into what promotions are available for you there."). Check the thread above first — if you already asked this state question, don't ask it again; instead circle back to email, framed around what's actually in it for them (e.g. "Just need your email too so I can actually get you those numbers — what's your email?"). Still asking for the email eventually, just not on every single turn in a row.
- Do not include a greeting/sign-off beyond what reads naturally in a text.
- If the message is spam, a phishing attempt, an automated notification, or otherwise not a real inquiry, set intent to spam_or_irrelevant and suggestedReply to null.

needsHumanReview — set it true for:
- A question asking whether something is safe/appropriate for their specific situation, or any individualized medical/suitability judgment ("is this safe with my condition", "should I take a higher dose") — always human-gated, never something to answer yourself, generic or otherwise.
- Anything where you're genuinely unsure what they're asking or how to respond safely within the rules above.
Leave it false for the ordinary cases: asking for a name or email, a plain informational question you can answer within the rules, or straightforward small talk.

For senderName and senderEmail: if we already know them, just return those same values. Otherwise extract only what the sender actually states themselves somewhere in the thread — never guess.

Possible existing customers this sender might be (matched by name appearing in their messages) — only pick one if you're confident, based on real evidence, never based on the topic alone. Note: even a confident match here always gets held for human review before anything is linked or sent — never treat a match as license to skip that.
${candidateList}`;
}

async function classifyAndDraft(
  fromPhone: string,
  fromName: string | null,
  collectedEmail: string | null,
  messages: readonly UnmatchedSmsMessage[],
  candidates: readonly MatchCandidate[],
  pendingConfirmation: boolean,
): Promise<UnmatchedSmsClassification> {
  const client = getClient();
  const transcript = buildTranscript(messages);

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(candidates, fromName, collectedEmail, pendingConfirmation),
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
  const classification = parseUnmatchedSmsClassification(toolBlock.input, candidates.length);
  if (!classification) {
    throw new Error("Claude returned an invalid classify_unmatched_sms tool payload.");
  }
  return classification;
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

export async function listUnmatchedSmsMessages(threadId: string): Promise<UnmatchedSmsMessage[]> {
  return db.select().from(unmatchedSmsMessagesTable).where(eq(unmatchedSmsMessagesTable.threadId, threadId)).orderBy(unmatchedSmsMessagesTable.createdAt);
}

/**
 * Records the inbound text/**
 * Records the inbound text (joining the sender's existing thread if one
 * exists) and attaches a best-effort classification/draft, re-run against
 * the FULL thread history each time — a Claude failure (timeout,
 * misconfigured key, malformed output) still leaves the message recorded
 * with nothing AI-generated attached, rather than losing it, and the
 * thread stays needs_review since there's no AI judgment to lean on. A new
 * inbound message on a thread previously replied-to or dismissed
 * resurfaces it by resetting status back to needs_review.
 */
export async function recordAndClassifyUnmatchedSms(fromPhone: string, body: string): Promise<UnmatchedSmsThread> {
  const normalizedPhone = normalizePhone(fromPhone);
  const thread = await getOrCreateThread(normalizedPhone);

  const priorMessages = await listUnmatchedSmsMessages(thread.id);
  if (priorMessages.length === 0) {
    void notifySlack(`New unmatched SMS — ${normalizedPhone}`);
  }

  await db.insert(unmatchedSmsMessagesTable).values({ threadId: thread.id, direction: "inbound", body });

  const messages = await listUnmatchedSmsMessages(thread.id);
  const transcriptText = messages.map((m) => m.body).join(" ");

  const candidates = await findMatchCandidates(thread.fromName, transcriptText).catch((err) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms candidate lookup failed");
    return [];
  });

  let classification: UnmatchedSmsClassification | null = null;
  try {
    classification = await classifyAndDraft(normalizedPhone, thread.fromName, thread.collectedEmail, messages, candidates, false);
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms classification failed");
  }

  const matchCandidate =
    classification?.matchCandidateIndex !== null && classification?.matchCandidateIndex !== undefined ? candidates[classification.matchCandidateIndex] : undefined;

  const [updated] = await db
    .update(unmatchedSmsThreadsTable)
    .set({
      aiIntent: classification?.intent ?? thread.aiIntent,
      aiSummary: classification?.summary ?? thread.aiSummary,
      suggestedReply: classification ? classification.suggestedReply : thread.suggestedReply,
      suggestedMatchCustomerId: classification ? (matchCandidate?.id ?? null) : thread.suggestedMatchCustomerId,
      suggestedMatchConfidence: classification && matchCandidate ? classification.matchConfidence : classification ? null : thread.suggestedMatchConfidence,
      status: "needs_review",
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

/** A staff-approved reply to an unmatched sender — the only path by which this pipeline sends anything. */
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
