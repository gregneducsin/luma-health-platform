import { eq, sql } from "drizzle-orm";
import { db, intakeLinkTokensTable, followUpJobsTable, type IntakeLinkToken } from "@luma/db";
import { generateRawToken, hashToken } from "../lib/crypto.js";

const INTAKE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_DELAY_MS = 2 * 60 * 60 * 1000;

export type PromoVariant = IntakeLinkToken["promoApplied"];

function baskQuestionnaireUrl(promo: PromoVariant): string {
  const envVar = promo === "first_month_20" ? "BASK_QUESTIONNAIRE_PROMO_URL" : "BASK_QUESTIONNAIRE_URL";
  const url = process.env[envVar];
  if (!url) {
    throw new Error(`${envVar} is not configured.`);
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
 *
 * `promo` picks which Bask URL variant this link redirects to, decided now
 * (e.g. by whether the conversation used the first_month_offer topic) —
 * never re-derived at click time, which happens hours later with no memory
 * of the conversation.
 */
export async function createIntakeLink(personId: string, promo: PromoVariant = "none"): Promise<{ url: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + INTAKE_LINK_TTL_MS);

  await db.insert(intakeLinkTokensTable).values({
    personId,
    tokenHash: hashToken(rawToken),
    promoApplied: promo,
    expiresAt,
  });

  return { url: `${intakeLinkBaseUrl()}/go/${rawToken}`, expiresAt };
}

/**
 * Resolve a click on an intake link. Always returns a Bask questionnaire URL
 * to redirect to — an unknown token falls back to the plain URL so a customer
 * never lands on an error page — but only a valid, unexpired, first-time
 * click on a known token arms the 2-hour follow-up job.
 */
export async function handleIntakeLinkClick(rawToken: string): Promise<{ redirectUrl: string }> {
  const tokenHash = hashToken(rawToken);

  return db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(intakeLinkTokensTable)
      .where(eq(intakeLinkTokensTable.tokenHash, tokenHash))
      .for("update");

    if (!token) {
      return { redirectUrl: baskQuestionnaireUrl("none") };
    }

    const redirectUrl = baskQuestionnaireUrl(token.promoApplied);
    const alreadyClicked = token.clickedAt !== null;
    const expired = token.expiresAt.getTime() <= Date.now();

    if (!alreadyClicked && !expired) {
      await tx.update(intakeLinkTokensTable).set({ clickedAt: sql`now()` }).where(eq(intakeLinkTokensTable.id, token.id));
      await tx.insert(followUpJobsTable).values({
        personId: token.personId,
        intakeLinkTokenId: token.id,
        messageStep: "provider_check_in",
        dueAt: new Date(Date.now() + FOLLOW_UP_DELAY_MS),
      });
    }

    return { redirectUrl };
  });
}
