import { and, asc, desc, eq, lt, sql, getTableColumns } from "drizzle-orm";
import { db, customersTable, purchasesTable, purchaseClassificationAuditsTable, type PurchaseStatus } from "@luma/db";
import type { CreatePurchaseRequest, ListPurchasesQuery, PurchasesSummaryQuery, UpdatePurchaseRequest } from "@luma/shared";

export async function listPurchasesForCustomer(customerId: string) {
  return db
    .select()
    .from(purchasesTable)
    .where(eq(purchasesTable.customerId, customerId))
    .orderBy(purchasesTable.purchaseDate);
}

const SORT_COLUMNS = {
  purchaseDate: purchasesTable.purchaseDate,
  amountPaid: purchasesTable.amountPaid,
} as const;

/** Order-level list across all customers, for the Orders tab. */
export async function listPurchases(query: ListPurchasesQuery) {
  const { sortBy, sortDir, limit, offset } = query;
  const orderFn = sortDir === "asc" ? asc : desc;

  const rows = await db
    .select({
      ...getTableColumns(purchasesTable),
      customerFirstName: customersTable.firstName,
      customerLastName: customersTable.lastName,
      customerPersonNumber: customersTable.personNumber,
    })
    .from(purchasesTable)
    .innerJoin(customersTable, eq(customersTable.id, purchasesTable.customerId))
    .orderBy(orderFn(SORT_COLUMNS[sortBy]))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(purchasesTable);

  return { purchases: rows, total };
}

/** Only "completed" purchases count toward revenue/customer figures — matches
 * how the Orders list itself surfaces status, and mirrors what the reference
 * dashboard's "Total Completed Orders" tile means. */
export async function getPurchasesSummary(query: PurchasesSummaryQuery) {
  const sinceCondition = query.period === "all" ? undefined : sql`${purchasesTable.purchaseDate} >= (current_date - ${query.period}::int)`;
  const completedCondition = eq(purchasesTable.status, "completed");
  const baseCondition = sinceCondition ? and(completedCondition, sinceCondition) : completedCondition;

  const [{ totalCompletedOrders, totalRevenue, purchasingCustomers }] = await db
    .select({
      totalCompletedOrders: sql<number>`count(*)::int`,
      totalRevenue: sql<string>`coalesce(sum(${purchasesTable.amountPaid}), 0)::text`,
      purchasingCustomers: sql<number>`count(distinct ${purchasesTable.customerId})::int`,
    })
    .from(purchasesTable)
    .where(baseCondition);

  const [{ newCustomers }] = await db
    .select({ newCustomers: sql<number>`count(distinct ${purchasesTable.customerId})::int` })
    .from(purchasesTable)
    .where(and(baseCondition, eq(purchasesTable.orderClassification, "first_order")));

  const [{ recurringCustomers }] = await db
    .select({ recurringCustomers: sql<number>`count(distinct ${purchasesTable.customerId})::int` })
    .from(purchasesTable)
    .where(and(baseCondition, eq(purchasesTable.orderClassification, "recurring")));

  return { purchasingCustomers, totalRevenue, totalCompletedOrders, newCustomers, recurringCustomers };
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
