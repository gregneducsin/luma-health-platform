import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { db, customersTable, emailConversationsTable, supportEmailConversationsTable } from "@luma/db";
import { recordWebhookEventIfNew, markWebhookEventProcessed, markWebhookEventFailed, caseInsensitiveEmailEq } from "./webhooks.service.js";
import { processInboundEmail } from "./lucy-email-dispatch.service.js";
import { processInboundSupportEmail } from "./sarah-email-dispatch.service.js";
import { htmlToPlainText } from "../lib/email/templates.js";
import { logger } from "../lib/logger.js";

/**
 * Cuts off a reply body at the start of the quoted history a mail client
 * appends below every reply ("On Tue, ... wrote:", or a run of "> " quote
 * lines) — without this, the pre-check/guardrail loop and the AI turn both
 * see the entire prior conversation pasted into a single inbound message
 * every time, which both re-triggers on old content and confuses the model
 * about what's actually new. Best-effort: matches the common Gmail/Apple
 * Mail/Outlook quote-header shapes, not exhaustive.
 */
const QUOTE_HEADER_RE = /(^|\n)(on .{0,80} wrote:|-{2,}\s*original message\s*-{2,}|from:\s*.+\n+sent:\s*.+)/i;

export function stripQuotedReply(bodyText: string): string {
  const lines = bodyText.split("\n");
  const quoteHeaderMatch = bodyText.match(QUOTE_HEADER_RE);
  let cut = quoteHeaderMatch ? bodyText.indexOf(quoteHeaderMatch[0]) : -1;

  if (cut === -1) {
    // Fall back to the first line that starts a run of "> " quoted lines.
    const idx = lines.findIndex((l) => l.trimStart().startsWith(">"));
    if (idx !== -1) {
      cut = lines.slice(0, idx).join("\n").length;
    }
  }

  const trimmed = cut === -1 ? bodyText : bodyText.slice(0, cut);
  return trimmed.trim();
}

function extractBodyText(parsed: { text?: string; html?: string | false }): string {
  if (parsed.text?.trim()) return parsed.text.trim();
  if (parsed.html) return htmlToPlainText(parsed.html);
  return "";
}

async function findCustomerIdByEmail(email: string): Promise<string | undefined> {
  const [row] = await db.select({ id: customersTable.id }).from(customersTable).where(caseInsensitiveEmailEq(email));
  return row?.id;
}

async function hasSupportEmailConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: supportEmailConversationsTable.id }).from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  return Boolean(row);
}

async function hasEmailConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: emailConversationsTable.id }).from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  return Boolean(row);
}

/**
 * Same support-conversation-first routing as iblusend-webhook.service.ts's
 * dispatchInboundMessage, matched by email instead of phone. See that
 * function's docstring for the full reasoning — identical here.
 */
async function dispatchInboundEmail(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<void> {
  if (await hasSupportEmailConversation(personId)) {
    await processInboundSupportEmail(personId, subject, bodyText, messageId);
    return;
  }
  if (await hasEmailConversation(personId)) {
    await processInboundEmail(personId, subject, bodyText, messageId);
    return;
  }
  logger.warn({ personId }, "inbound email from a person with no Lucy or Sarah email conversation — no auto-reply sent");
}

function imapConfig(): { host: string; user: string; pass: string } {
  const user = process.env.GOOGLE_WORKSPACE_SMTP_USER;
  const pass = process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("GOOGLE_WORKSPACE_SMTP_USER/GOOGLE_WORKSPACE_SMTP_APP_PASSWORD is not set — required for IMAP polling too (same mailbox, same app password).");
  }
  return { host: "imap.gmail.com", user, pass };
}

export interface EmailInboundSweepResult {
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
}

/**
 * Polls the connected Google Workspace mailbox for unread mail, once per
 * call — same "sweep" shape as the SMS trigger sweeps (sweepAbandonedCartTriggers
 * etc.), just polling an inbox instead of due DB rows. Idempotency is DB-level
 * (webhook_events, keyed on the RFC 5322 Message-ID), not merely the IMAP
 * \Seen flag — a flag that failed to set, or a mailbox re-sync, can't cause
 * a double-reply. Safe to call repeatedly, including overlapping runs, for
 * the same reason every other sweep in this codebase is: whichever call
 * wins the DB-level claim (recordWebhookEventIfNew) is the only one that acts.
 */
export async function sweepInboundEmail(): Promise<EmailInboundSweepResult> {
  const { host, user, pass } = imapConfig();
  const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false });

  let processedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        let message: FetchMessageObject | false;
        try {
          message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        } catch (err) {
          logger.warn({ uid, reason: err instanceof Error ? err.message : String(err) }, "failed to fetch inbound email");
          failedCount++;
          continue;
        }
        if (!message || !message.source) {
          skippedCount++;
          continue;
        }

        const parsed = await simpleParser(message.source);
        const fromAddress = parsed.from?.value[0]?.address;
        const externalEventId = parsed.messageId ?? `imap-uid-${uid}`;

        const recorded = await recordWebhookEventIfNew("email_inbound", externalEventId, { uid, from: fromAddress, subject: parsed.subject });
        if (!recorded) {
          // Already processed this delivery — still mark it read so future
          // polls don't keep re-fetching it.
          await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true }).catch(() => undefined);
          skippedCount++;
          continue;
        }

        try {
          if (!fromAddress) {
            throw new Error("Inbound email has no From address.");
          }
          const personId = await findCustomerIdByEmail(fromAddress);
          if (!personId) {
            logger.warn({ fromDomain: fromAddress.split("@")[1] }, "inbound email from an unrecognized address — no matching customer");
            await markWebhookEventProcessed(recorded.id);
          } else {
            const bodyText = stripQuotedReply(extractBodyText(parsed));
            await dispatchInboundEmail(personId, parsed.subject ?? "(no subject)", bodyText, parsed.messageId ?? null);
            await markWebhookEventProcessed(recorded.id, personId);
          }
          processedCount++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await markWebhookEventFailed(recorded.id, reason);
          logger.error({ reason }, "inbound email processing failed");
          failedCount++;
        }

        await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true }).catch(() => undefined);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  if (processedCount > 0 || failedCount > 0) {
    logger.info({ processedCount, skippedCount, failedCount }, "inbound email sweep completed");
  }

  return { processedCount, skippedCount, failedCount };
}
