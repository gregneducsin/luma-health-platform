import { and, eq, lt } from "drizzle-orm";
import { db, purchasesTable, purchaseClassificationAuditsTable, type PurchaseStatus } from "@luma/db";
import type { CreatePurchaseRequest, UpdatePurchaseRequest } from "@luma/shared";

export async function listPurchasesForCustomer(customerId: string) {
  return db
    .select()
    .from(purchasesTable)
    .where(eq(purchasesTable.customerId, customerId))
    .orderBy(purchasesTable.purchaseDate);
}

/**
 * Classifies a new purchase as "first_order" if no earlier purchase exists
 * for this customer, else "recurring" — same rule the old app used
 * ("classified based on order within the person's history"), with
 * source="manual" since this is the admin-driven creation path (webhooks
 * in Phase 5 will use source="bask" instead).
 */
export async function createPurchase(customerId: string, input: CreatePurchaseRequest) {
  return db.transaction(async (tx) => {
    const [earlier] = await tx
      .select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(and(eq(purchasesTable.customerId, customerId), lt(purchasesTable.purchaseDate, input.purchaseDate)));

    const [purchase] = await tx
      .insert(purchasesTable)
      .values({
        customerId,
        purchaseDate: input.purchaseDate,
        orderNumber: input.orderNumber,
        productName: input.productName,
        amountPaid: input.amountPaid,
        status: input.status ?? "completed",
        ecommerceOrderId: input.ecommerceOrderId,
        orderClassification: earlier ? "recurring" : "first_order",
        orderClassificationSource: "manual",
      })
      .returning();
    return purchase;
  });
}

export async function updatePurchase(id: number, input: UpdatePurchaseRequest, actor: { id: string; email: string }) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(purchasesTable).where(eq(purchasesTable.id, id));
    if (!existing) return null;

    const patch: Partial<typeof purchasesTable.$inferInsert> = {
      ...(input.purchaseDate !== undefined ? { purchaseDate: input.purchaseDate } : {}),
      ...(input.orderNumber !== undefined ? { orderNumber: input.orderNumber } : {}),
      ...(input.productName !== undefined ? { productName: input.productName } : {}),
      ...(input.amountPaid !== undefined ? { amountPaid: input.amountPaid } : {}),
      ...(input.status !== undefined ? { status: input.status as PurchaseStatus } : {}),
    };

    if (input.orderClassification !== undefined && input.orderClassification !== existing.orderClassification) {
      patch.orderClassification = input.orderClassification;
      patch.orderClassificationSource = "manual";
      await tx.insert(purchaseClassificationAuditsTable).values({
        purchaseId: id,
        changedBy: actor.email,
        previousClassification: existing.orderClassification,
        newClassification: input.orderClassification,
        previousSource: existing.orderClassificationSource,
        newSource: "manual",
      });
    }

    const [updated] = await tx.update(purchasesTable).set(patch).where(eq(purchasesTable.id, id)).returning();
    return updated;
  });
}
