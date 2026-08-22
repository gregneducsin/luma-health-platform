import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  customersTable,
  intakeLinkTokensTable,
  followUpJobsTable,
  abandonedCartTriggersTable,
  leadCheckinTriggersTable,
  objectionReengagementTriggersTable,
  abandonedCartEmailTriggersTable,
  metaLeadEmailTriggersTable,
  reviewRequestTriggersTable,
  questionnaireEventsTable,
} from "@luma/db";
import { hashToken } from "../lib/crypto.js";

const { getUpcomingTrigger } = await import("./scheduled-triggers.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Trigger", lastName: "Test", email: `trigger-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedQuestionnaireEvent(personId: string): Promise<string> {
  const [row] = await db
    .insert(questionnaireEventsTable)
    .values({ personId, questionnaireId: `q-${crypto.randomUUID()}`, status: "abandoned", lastEventAt: new Date() })
    .returning({ id: questionnaireEventsTable.id });
  return row.id;
}

describe("getUpcomingTrigger", () => {
  it("returns null when nothing is scheduled for this person", async () => {
    const personId = await seedCustomer();
    expect(await getUpcomingTrigger(personId)).toBeNull();
  });

  it("returns a follow-up job with a step-specific label", async () => {
    const personId = await seedCustomer();
    const [token] = await db
      .insert(intakeLinkTokensTable)
      .values({ personId, tokenHash: hashToken(`token-${crypto.randomUUID()}`), expiresAt: new Date(Date.now() + 86_400_000), clickedAt: new Date() })
      .returning({ id: intakeLinkTokensTable.id });
    const dueAt = new Date(Date.now() + 60_000);
    await db.insert(followUpJobsTable).values({ personId, intakeLinkTokenId: token.id, messageStep: "intake_questions_check_in", dueAt });

    const trigger = await getUpcomingTrigger(personId);
    expect(trigger).toMatchObject({ kind: "follow_up", label: "Intake questions follow-up text", status: "pending" });
    expect(trigger?.dueAt.getTime()).toBe(dueAt.getTime());
  });

  it("returns an abandoned-cart email trigger with a step-specific label", async () => {
    const personId = await seedCustomer();
    const questionnaireEventId = await seedQuestionnaireEvent(personId);
    const dueAt = new Date(Date.now() + 60_000);
    await db.insert(abandonedCartEmailTriggersTable).values({ personId, questionnaireEventId, step: "urgency", dueAt });

    const trigger = await getUpcomingTrigger(personId);
    expect(trigger).toMatchObject({ kind: "abandoned_cart_email", label: "Urgency email", status: "pending" });
  });

  it("returns a review-request trigger", async () => {
    const personId = await seedCustomer();
    const dueAt = new Date(Date.now() + 60_000);
    await db.insert(reviewRequestTriggersTable).values({ personId, dueAt });

    const trigger = await getUpcomingTrigger(personId);
    expect(trigger).toMatchObject({ kind: "review_request_sms", label: "Review-request text", status: "pending" });
  });

  it("picks the soonest across multiple trigger tables, not just the first one queried", async () => {
    const personId = await seedCustomer();
    await db.insert(leadCheckinTriggersTable).values({ personId, dueAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000) });
    await db.insert(objectionReengagementTriggersTable).values({ personId, dueAt: new Date(Date.now() + 60_000) }); // soonest
    await db.insert(metaLeadEmailTriggersTable).values({ personId, step: "opener", dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000) });

    const trigger = await getUpcomingTrigger(personId);
    expect(trigger?.kind).toBe("objection_reengagement_sms");
  });

  it("counts a 'processing' row as upcoming, not just 'pending'", async () => {
    const personId = await seedCustomer();
    const [trigger] = await db.insert(abandonedCartTriggersTable).values({ personId, questionnaireEventId: await seedQuestionnaireEvent(personId), dueAt: new Date(Date.now() + 60_000) }).returning();
    await db.update(abandonedCartTriggersTable).set({ status: "processing" }).where(eq(abandonedCartTriggersTable.id, trigger.id));

    const result = await getUpcomingTrigger(personId);
    expect(result).toMatchObject({ kind: "abandoned_cart_sms", status: "processing" });
  });

  it("ignores rows that are already sent, cancelled, or failed", async () => {
    const personId = await seedCustomer();
    await db.insert(reviewRequestTriggersTable).values({ personId, dueAt: new Date(Date.now() - 60_000), status: "sent" });
    await db.insert(leadCheckinTriggersTable).values({ personId, dueAt: new Date(Date.now() - 60_000), status: "cancelled" });
    await db.insert(objectionReengagementTriggersTable).values({ personId, dueAt: new Date(Date.now() - 60_000), status: "failed" });

    expect(await getUpcomingTrigger(personId)).toBeNull();
  });
});
