import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";

/** True once a customer has opted out (STOP/UNSUBSCRIBE) and hasn't purchased since. */
export async function isCustomerDnd(personId: string): Promise<boolean> {
  const [row] = await db.select({ dnd: customersTable.dnd }).from(customersTable).where(eq(customersTable.id, personId));
  return row?.dnd ?? false;
}

/**
 * Sets or clears a customer's do-not-disturb flag. Set true on an inbound
 * STOP/UNSUBSCRIBE (see the OPT_OUT pre-check code in lucy-dispatch.service.ts
 * and sarah-dispatch.service.ts); cleared automatically the moment the
 * customer makes a purchase (purchases.service.ts's createPurchase and
 * webhooks.service.ts's handleBaskOrderWebhook) — a purchase is treated as
 * fresh consent to be messaged again.
 */
export async function setCustomerDnd(personId: string, dnd: boolean): Promise<void> {
  await db
    .update(customersTable)
    .set({ dnd, dndAt: dnd ? new Date() : null })
    .where(eq(customersTable.id, personId));
}
