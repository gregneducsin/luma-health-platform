import { asc, desc, eq, ilike, or, sql, getTableColumns } from "drizzle-orm";
import { db, customersTable, purchasesTable } from "@luma/db";
import type { CreateCustomerRequest, ListCustomersQuery, UpdateCustomerRequest } from "@luma/shared";

const SORT_COLUMNS = {
  createdAt: customersTable.createdAt,
  leadReceivedDate: customersTable.leadReceivedDate,
  lastName: customersTable.lastName,
} as const;

export async function listCustomers(query: ListCustomersQuery) {
  const { search, sortBy, sortDir, limit, offset } = query;

  const searchCondition = search
    ? or(
        ilike(customersTable.firstName, `%${search}%`),
        ilike(customersTable.lastName, `%${search}%`),
        ilike(customersTable.email, `%${search}%`),
        ilike(customersTable.phone, `%${search}%`),
      )
    : undefined;

  const orderFn = sortDir === "asc" ? asc : desc;

  const rows = await db
    .select({
      ...getTableColumns(customersTable),
      purchaseCount: sql<number>`count(${purchasesTable.id})::int`,
      totalPaid: sql<string>`coalesce(sum(${purchasesTable.amountPaid}), 0)::text`,
      firstPurchaseDate: sql<string | null>`min(${purchasesTable.purchaseDate})`,
      mostRecentPurchaseDate: sql<string | null>`max(${purchasesTable.purchaseDate})`,
    })
    .from(customersTable)
    .leftJoin(purchasesTable, eq(purchasesTable.customerId, customersTable.id))
    .where(searchCondition)
    .groupBy(customersTable.id)
    .orderBy(orderFn(SORT_COLUMNS[sortBy]))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(customersTable)
    .where(searchCondition);

  return { customers: rows, total };
}

export async function getCustomer(id: string) {
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  return customer ?? null;
}

export async function createCustomer(input: CreateCustomerRequest) {
  const [customer] = await db
    .insert(customersTable)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      leadReceivedDate: input.leadReceivedDate,
      leadType: input.leadType ?? "Other / Unknown",
      leadCreatedAt: new Date(),
    })
    .returning();
  return customer;
}

export async function updateCustomer(id: string, input: UpdateCustomerRequest) {
  const [customer] = await db
    .update(customersTable)
    .set(input)
    .where(eq(customersTable.id, id))
    .returning();
  return customer ?? null;
}
