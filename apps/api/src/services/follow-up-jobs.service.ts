import { and, eq, lte, sql } from "drizzle-orm";
import { db, followUpJobsTable, intakeLinkTokensTable, questionnaireEventsTable, purchasesTable } from "@luma/db";
import { logger } from "../lib/logger.js";

export interface FollowUpSweepResult {
  readonly readyCount: number;
  readonly cancelledCount: number;
}

/**
 * Find every `pending` follow-up job whose due time has passed, and resolve
 * each one:
 *   - if the person already submitted the questionnaire or completed a
 *     purchase since they clicked the link, cancel the job — no follow-up needed.
 *   - otherwise, flip it to `ready`. Sending is not wired up yet (no SMS/phone
 *     provider chosen) — `ready` jobs are a manual follow-up queue for now.
 *
 * Safe to call repeatedly (e.g. from a periodic sweep) — jobs are only ever
 * read while `pending` and moved to a terminal-for-this-sweep state, so a
 * job is never processed twice.
 */
export async function sweepFollowUpJobs(): Promise<FollowUpSweepResult> {
  const dueJobs = await db
    .select({
      jobId: followUpJobsTable.id,
      personId: followUpJobsTable.personId,
      clickedAt: intakeLinkTokensTable.clickedAt,
    })
    .from(followUpJobsTable)
    .innerJoin(intakeLinkTokensTable, eq(intakeLinkTokensTable.id, followUpJobsTable.intakeLinkTokenId))
    .where(and(eq(followUpJobsTable.status, "pending"), lte(followUpJobsTable.dueAt, sql`now()`)));

  let readyCount = 0;
  let cancelledCount = 0;

  for (const job of dueJobs) {
    const completed = await hasCompletedSinceClick(job.personId, job.clickedAt);

    if (completed) {
      await db
        .update(followUpJobsTable)
        .set({ status: "cancelled", cancelledReason: "completed_before_followup" })
        .where(eq(followUpJobsTable.id, job.jobId));
      cancelledCount++;
    } else {
      await db.update(followUpJobsTable).set({ status: "ready", readyAt: sql`now()` }).where(eq(followUpJobsTable.id, job.jobId));
      readyCount++;
    }
  }

  if (readyCount > 0 || cancelledCount > 0) {
    logger.info({ readyCount, cancelledCount }, "follow-up job sweep completed");
  }

  return { readyCount, cancelledCount };
}

async function hasCompletedSinceClick(personId: string, clickedAt: Date | null): Promise<boolean> {
  if (!clickedAt) return false;

  const [submitted] = await db
    .select({ id: questionnaireEventsTable.id })
    .from(questionnaireEventsTable)
    .where(and(eq(questionnaireEventsTable.personId, personId), eq(questionnaireEventsTable.status, "submitted"), sql`${questionnaireEventsTable.lastEventAt} >= ${clickedAt}`))
    .limit(1);
  if (submitted) return true;

  const [purchased] = await db
    .select({ id: purchasesTable.id })
    .from(purchasesTable)
    .where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"), sql`${purchasesTable.purchaseDate} >= ${clickedAt}::date`))
    .limit(1);
  return Boolean(purchased);
}
