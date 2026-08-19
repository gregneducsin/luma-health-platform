import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, sql } from "drizzle-orm";
import { db, customersTable, unmatchedInboundEmailsTable, type UnmatchedInboundEmail } from "@luma/db";
import { getEmailProvider } from "../lib/email-provider.js";
import { logger } from "../lib/logger.js";

/**
 * What used to happen to an inbound email from an address matching no
 * customer record: logged and silently dropped, invisible to staff. This
 * records it instead, with a Claude-drafted classification and suggested
 * reply attached for a human to review — nothing here ever sends
 * automatically or attaches the message to an existing customer's
 * conversation on its own. Health-context correspondence misrouted to the
 * wrong person, or an unreviewed AI reply going out to a stranger, is
 * exactly the failure mode a background sweep with nobody watching must
 * not risk — so every output of this pipeline is a suggestion, not an
 * action, until staff confirms it from the dashboard.
 */

const MODEL = "claude-haiku-4-5-20251001";
const CALL_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 4_000;

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
 * sender's display name or the email body. This is deliberately narrow —
 * the cost of a false positive here (suggesting the wrong person as a
 * match on a health-context thread) is much higher than the cost of
 * missing a real match that staff could instead find by searching manually.
 */
async function findMatchCandidates(fromName: string | null, body: string): Promise<MatchCandidate[]> {
  const searchText = `${fromName ?? ""} ${body}`.trim();
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
  readonly matchCandidateIndex: number | null;
  readonly matchConfidence: "high" | "medium" | "low" | null;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_unmatched_email",
  description: "Classify an inbound email from an unrecognized sender and draft a safe, generic suggested reply for staff to review before sending.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"] },
      summary: { type: "string", description: "One sentence: what does this person want?" },
      suggestedReply: {
        type: ["string", "null"],
        description: "A short, safe, generic reply body — no greeting/sign-off (added separately), no clinical claims, no pricing figures, no promises. Null for spam_or_irrelevant.",
      },
      matchCandidateIndex: {
        type: ["integer", "null"],
        description: "0-based index into the provided candidate list if this sender is plausibly one of those existing customers, else null. Never guess beyond the given list.",
      },
      matchConfidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
    },
    required: ["intent", "summary", "suggestedReply", "matchCandidateIndex", "matchConfidence"],
  },
};

function systemPrompt(candidates: readonly MatchCandidate[]): string {
  const candidateList = candidates.length
    ? candidates.map((c, i) => `${i}: ${c.firstName} ${c.lastName} (${c.email})`).join("\n")
    : "(no plausible candidates found)";

  return `You triage inbound email at Luma Health, a healthcare company, for a sender whose email address doesn't match any customer record in the CRM.

Classify the message and draft a short suggested reply for a staff member to review — you are never sending anything yourself, only drafting.

Rules for the suggested reply:
- Never state or imply a price, discount, or specific dollar figure.
- Never give clinical/medical advice, dosing information, or comment on a specific medication.
- Never promise a timeline, outcome, or that a specific person will follow up.
- Keep it to 1-3 short sentences. Acknowledge what they asked, and say a member of the team will follow up. If their intent is unclear, ask one clarifying question instead.
- Do not include a greeting ("Hi ...") or sign-off — those are added separately.
- If the message is spam, a phishing attempt, an automated notification, or otherwise not a real inquiry, set intent to spam_or_irrelevant and suggestedReply to null.

Possible existing customers this sender might be (matched by name appearing in their message) — only pick one if you're confident, based on real evidence in the message (e.g. they sign the email with a matching name), never based on the topic alone:
${candidateList}`;
}

async function classifyAndDraft(fromAddress: string, fromName: string | null, subject: string, body: string, candidates: readonly MatchCandidate[]): Promise<Classification> {
  const client = getClient();
  const truncatedBody = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}...` : body;

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(candidates),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_unmatched_email" },
    messages: [
      {
        role: "user",
        content: `From: ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}\nSubject: ${subject}\n\n${truncatedBody}`,
      },
    ],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));
  const response = await Promise.race([createPromise, timeoutPromise]);

  const toolBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_unmatched_email");
  if (!toolBlock) {
    throw new Error("Claude did not return a classify_unmatched_email tool call.");
  }
  return toolBlock.input as Classification;
}

/**
 * Records the email and attaches a best-effort classification/draft — a
 * Claude failure (timeout, misconfigured key, malformed output) still
 * results in a plain needs_review record with nothing AI-generated
 * attached, rather than losing the email entirely.
 */
export async function recordAndClassifyUnmatchedEmail(input: {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  body: string;
  messageId: string | null;
}): Promise<UnmatchedInboundEmail> {
  const candidates = await findMatchCandidates(input.fromName, input.body).catch((err) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-email candidate lookup failed");
    return [];
  });

  let classification: Classification | null = null;
  try {
    classification = await classifyAndDraft(input.fromAddress, input.fromName, input.subject, input.body, candidates);
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-email classification failed");
  }

  const matchCandidate =
    classification?.matchCandidateIndex !== null && classification?.matchCandidateIndex !== undefined
      ? candidates[classification.matchCandidateIndex]
      : undefined;

  const [row] = await db
    .insert(unmatchedInboundEmailsTable)
    .values({
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      subject: input.subject,
      body: input.body,
      messageId: input.messageId,
      aiIntent: classification?.intent ?? null,
      aiSummary: classification?.summary ?? null,
      suggestedReply: classification?.suggestedReply ?? null,
      suggestedMatchCustomerId: matchCandidate?.id ?? null,
      suggestedMatchConfidence: matchCandidate ? classification?.matchConfidence ?? null : null,
    })
    .returning();
  return row;
}

export async function listUnmatchedInboundEmails(): Promise<UnmatchedInboundEmail[]> {
  return db.select().from(unmatchedInboundEmailsTable).orderBy(desc(unmatchedInboundEmailsTable.createdAt));
}

export async function getUnmatchedInboundEmail(id: string): Promise<UnmatchedInboundEmail | undefined> {
  const [row] = await db.select().from(unmatchedInboundEmailsTable).where(eq(unmatchedInboundEmailsTable.id, id));
  return row;
}

export async function dismissUnmatchedInboundEmail(id: string): Promise<boolean> {
  const [row] = await db.update(unmatchedInboundEmailsTable).set({ status: "dismissed" }).where(eq(unmatchedInboundEmailsTable.id, id)).returning({ id: unmatchedInboundEmailsTable.id });
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

/** A staff-approved reply to an unmatched sender — the only path by which this pipeline ever actually sends anything. */
export async function sendUnmatchedInboundEmailReply(id: string, body: string): Promise<UnmatchedEmailReplyResult> {
  const row = await getUnmatchedInboundEmail(id);
  if (!row) return { sent: false, reason: "not_found" };

  const subject = /^re:/i.test(row.subject.trim()) ? row.subject : `Re: ${row.subject}`;
  try {
    const { provider } = getEmailProvider("lucy");
    const html = wrapReplyHtml(body);
    await provider.sendEmail(row.fromAddress, subject, html, {
      fromName: "Luma Health Team",
      inReplyTo: row.messageId ?? undefined,
      references: row.messageId ?? undefined,
    });
  } catch (err) {
    logger.warn({ id, reason: err instanceof Error ? err.message : String(err) }, "unmatched-email staff reply send failed");
    return { sent: false, reason: "send_failed" };
  }

  await db.update(unmatchedInboundEmailsTable).set({ status: "replied", repliedAt: new Date() }).where(eq(unmatchedInboundEmailsTable.id, id));
  return { sent: true };
}
