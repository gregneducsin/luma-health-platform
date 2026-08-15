import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, intakeLinkTokensTable, followUpJobsTable } from "@luma/db";
import { generateRawToken, hashToken } from "../lib/crypto.js";

const INTAKE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_DELAY_MS = 2 * 60 * 60 * 1000;

function baskQuestionnaireUrl(): string {
  const url = process.env.BASK_QUESTIONNAIRE_URL;
  if (!url) {
    throw new Error("BASK_QUESTIONNAIRE_URL is not configured.");
  }
  return url;
}

function intakeLinkBaseUrl(): string {
  const url = process.env.INTAKE_LINK_BASE_URL;
  if (!url) {
    throw new Error("INTAKE_LINK_BASE_URL is not configured.");
  }
  return url;
}

/**
 * Mint a one-time trigger link for a lead (e.g. an abandoned-questionnaire
 * nudge). The raw token is returned exactly once and is never stored — only
 * its SHA-256 hash is persisted, same convention as session/invitation tokens.
 */
export async function createIntakeLink(personId: string): Promise<{ url: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + INTAKE_LINK_TTL_MS);

  await db.insert(intakeLinkTokensTable).values({
    personId,
    tokenHash: hashToken(rawToken),
    expiresAt,
  });

  return { url: `${intakeLinkBaseUrl()}/go/${rawToken}`, expiresAt };
}

/**
 * Resolve a click on an intake link. Always returns the (universal) Bask
 * questionnaire URL to redirect to — an unknown or expired token still
 * redirects there, so a customer never lands on an error page — but only a
 * valid, unexpired, first-time click arms the 2-hour follow-up job.
 */
export async function handleIntakeLinkClick(rawToken: string): Promise<{ redirectUrl: string }> {
  const redirectUrl = baskQuestionnaireUrl();
  const tokenHash = hashToken(rawToken);

  const [token] = await db
    .update(intakeLinkTokensTable)
    .set({ clickedAt: sql`now()` })
    .where(and(eq(intakeLinkTokensTable.tokenHash, tokenHash), isNull(intakeLinkTokensTable.clickedAt), gt(intakeLinkTokensTable.expiresAt, sql`now()`)))
    .returning({ id: intakeLinkTokensTable.id, personId: intakeLinkTokensTable.personId });

  // No row updated means either: unknown token, already clicked once before
  // (repeat click — redirect only, don't re-arm), or expired. Either way we
  // still redirect; we just don't schedule a follow-up.
  if (token) {
    await db.insert(followUpJobsTable).values({
      personId: token.personId,
      intakeLinkTokenId: token.id,
      jobType: "abandoned_intake_followup",
      dueAt: new Date(Date.now() + FOLLOW_UP_DELAY_MS),
    });
  }

  return { redirectUrl };
}
