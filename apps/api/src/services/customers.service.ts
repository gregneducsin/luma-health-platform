import { and, asc, desc, eq, ilike, or, sql, getTableColumns } from "drizzle-orm";
import { db, customersTable, purchasesTable, questionnaireEventsTable, externalIdentitiesTable } from "@luma/db";
import type { CreateCustomerRequest, CustomersSummaryQuery, ListCustomersQuery, UpdateCustomerRequest } from "@luma/shared";

const SORT_COLUMNS = {
  createdAt: customersTable.createdAt,
  leadReceivedDate: customersTable.leadReceivedDate,
  lastName: customersTable.lastName,
} as const;

// Most recent questionnaire_events row per customer — a correlated subquery
// rather than a join, since joining would multiply customer rows by however
// many questionnaire events they have and break the purchases aggregate below.
const questionnaireStatusSubquery = sql<string | null>`(
  select ${questionnaireEventsTable.status}
  from ${questionnaireEventsTable}
  where ${questionnaireEventsTable.personId} = ${customersTable.id}
  order by ${questionnaireEventsTable.lastEventAt} desc
  limit 1
)`;

export async function listCustomers(query: ListCustomersQuery) {
  const { search, sortBy, sortDir, limit, offset, leadType, purchaseStatus, questionnaireStatus } = query;

  const conditions = [
    search
      ? or(
          ilike(customersTable.firstName, `%${search}%`),
          ilike(customersTable.lastName, `%${search}%`),
          ilike(customersTable.email, `%${search}%`),
          ilike(customersTable.phone, `%${search}%`),
        )
      : undefined,
    leadType ? eq(customersTable.leadType, leadType) : undefined,
    questionnaireStatus
      ? sql`exists (select 1 from ${questionnaireEventsTable} where ${questionnaireEventsTable.personId} = ${customersTable.id} and ${questionnaireEventsTable.status} = ${questionnaireStatus})`
      : undefined,
  ].filter((c) => c !== undefined);
  const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const havingCondition =
    purchaseStatus === "purchased"
      ? sql`count(${purchasesTable.id}) > 0`
      : purchaseStatus === "not_purchased"
        ? sql`count(${purchasesTable.id}) = 0`
        : undefined;

  const orderFn = sortDir === "asc" ? asc : desc;

  const rows = await db
    .select({
      ...getTableColumns(customersTable),
      purchaseCount: sql<number>`count(${purchasesTable.id})::int`,
      totalPaid: sql<string>`coalesce(sum(${purchasesTable.amountPaid}), 0)::text`,
      firstPurchaseDate: sql<string | null>`min(${purchasesTable.purchaseDate})`,
      mostRecentPurchaseDate: sql<string | null>`max(${purchasesTable.purchaseDate})`,
      questionnaireStatus: questionnaireStatusSubquery,
    })
    .from(customersTable)
    .leftJoin(purchasesTable, eq(purchasesTable.customerId, customersTable.id))
    .where(whereCondition)
    .groupBy(customersTable.id)
    .having(havingCondition)
    .orderBy(orderFn(SORT_COLUMNS[sortBy]))
    .limit(limit)
    .offset(offset);

  // HAVING filters per-customer groups, so the total count needs the same
  // grouped query as a subquery — a plain count(distinct id) with a bare
  // HAVING (no matching GROUP BY on this query) would evaluate the purchase
  // condition once over the whole joined result set instead of per customer.
  const matchingCustomerIds = db
    .select({ id: customersTable.id })
    .from(customersTable)
    .leftJoin(purchasesTable, eq(purchasesTable.customerId, customersTable.id))
    .where(whereCondition)
    .groupBy(customersTable.id)
    .having(havingCondition)
    .as("matching_customers");
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(matchingCustomerIds);

  return { customers: rows, total: total ?? 0 };
}

// A customer's acquisition source = the system of their earliest
// external_identities row ("first touch"), so every customer with a known
// source falls into exactly one bucket — no double-counting a lead that
// later also touched the other system (e.g. a GHL lead who later filled
// out a Bask questionnaire still counts once, under GHL).
const firstTouchSystemSql = sql`(
  select ${externalIdentitiesTable.system}
  from ${externalIdentitiesTable}
  where ${externalIdentitiesTable.personId} = ${customersTable.id}
  order by ${externalIdentitiesTable.createdAt} asc
  limit 1
)`;

export async function getCustomersSummary(query: CustomersSummaryQuery) {
  const sinceCondition =
    query.period === "all" ? undefined : sql`${customersTable.leadReceivedDate} >= (current_date - ${query.period}::int)`;

  const [{ totalLeads }] = await db.select({ totalLeads: sql<number>`count(*)::int` }).from(customersTable).where(sinceCondition);

  const [{ purchased }] = await db
    .select({ purchased: sql<number>`count(distinct ${customersTable.id})::int` })
    .from(customersTable)
    .innerJoin(purchasesTable, eq(purchasesTable.customerId, customersTable.id))
    .where(sinceCondition);

  const notPurchased = totalLeads - purchased;
  const conversionRate = totalLeads > 0 ? Math.round((purchased / totalLeads) * 1000) / 10 : 0;

  const metaFormFillCondition = sql`${firstTouchSystemSql} = 'ghl'`;
  const questionnaireCondition = sql`${firstTouchSystemSql} = 'bask'`;

  const [{ metaFormFillCount }] = await db
    .select({ metaFormFillCount: sql<number>`count(*)::int` })
    .from(customersTable)
    .where(sinceCondition ? and(sinceCondition, metaFormFillCondition) : metaFormFillCondition);

  const [{ questionnaireCount }] = await db
    .select({ questionnaireCount: sql<number>`count(*)::int` })
    .from(customersTable)
    .where(sinceCondition ? and(sinceCondition, questionnaireCondition) : questionnaireCondition);

  return { totalLeads, metaFormFillCount, questionnaireCount, purchased, notPurchased, conversionRate };
}

export async function listDistinctLeadTypes() {
  const rows = await db.selectDistinct({ leadType: customersTable.leadType }).from(customersTable).orderBy(customersTable.leadType);
  return rows.map((r) => r.leadType);
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
