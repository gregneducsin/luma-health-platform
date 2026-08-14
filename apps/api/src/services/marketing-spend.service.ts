import { eq } from "drizzle-orm";
import { db, marketingSpendWeeksTable } from "@luma/db";
import type { CreateMarketingSpendWeekRequest, UpdateMarketingSpendWeekRequest } from "@luma/shared";

export async function listMarketingSpendWeeks() {
  return db.select().from(marketingSpendWeeksTable).orderBy(marketingSpendWeeksTable.weekStart);
}

export async function createMarketingSpendWeek(input: CreateMarketingSpendWeekRequest, actor: { email: string }) {
  const [week] = await db
    .insert(marketingSpendWeeksTable)
    .values({
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      advertisingCost: input.advertisingCost,
      notes: input.notes,
      createdBy: actor.email,
      updatedBy: actor.email,
    })
    .returning();
  return week;
}

export async function updateMarketingSpendWeek(id: string, input: UpdateMarketingSpendWeekRequest, actor: { email: string }) {
  const [week] = await db
    .update(marketingSpendWeeksTable)
    .set({ ...input, updatedBy: actor.email })
    .where(eq(marketingSpendWeeksTable.id, id))
    .returning();
  return week ?? null;
}
