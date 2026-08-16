import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "employee") {
  const { db, appUsersTable } = await import("@luma/db");
  const { hashPassword } = await import("../lib/crypto.js");
  const [user] = await db
    .insert(appUsersTable)
    .values({ email, normalizedEmail: email, role, status: "active", passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return user;
}

async function loginAgent(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const csrf = (await agent.get("/api/app/auth/csrf-token")).body.csrfToken as string;
  await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });
  return { agent, csrf };
}

describe("Customers CRUD", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers");
    expect(res.status).toBe(401);
  });

  it("rejects employee role (requires admin/manager)", async () => {
    await seedUser("employee1@example.com", "employee");
    const { agent } = await loginAgent(app, "employee1@example.com");
    const res = await agent.get("/api/app/customers");
    expect(res.status).toBe(403);
  });

  it("allows manager to read but not create", async () => {
    await seedUser("manager1@example.com", "manager");
    const { agent, csrf } = await loginAgent(app, "manager1@example.com");

    const listRes = await agent.get("/api/app/customers");
    expect(listRes.status).toBe(200);

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "A", lastName: "B", email: "ab@example.com", leadReceivedDate: "2026-01-01" });
    expect(createRes.status).toBe(403);
  });

  it("admin can create, read, update a customer and add a purchase", async () => {
    await seedUser("admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin1@example.com");

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane.doe@example.com",
        phone: "+12025550100",
        leadReceivedDate: "2026-01-15",
      });
    expect(createRes.status).toBe(201);
    const customer = createRes.body.customer;
    expect(customer.personNumber).toMatch(/^PER-\d{6}$/);

    const getRes = await agent.get(`/api/app/customers/${customer.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.customer.email).toBe("jane.doe@example.com");
    expect(getRes.body.purchases).toEqual([]);

    const updateRes = await agent
      .patch(`/api/app/customers/${customer.id}`)
      .set("x-csrf-token", csrf)
      .send({ leadType: "Referral" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.customer.leadType).toBe("Referral");

    // First purchase -> classified first_order
    const purchase1 = await agent
      .post(`/api/app/customers/${customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-02-01", orderNumber: "ORD-1", productName: "Widget", amountPaid: "49.99" });
    expect(purchase1.status).toBe(201);
    expect(purchase1.body.purchase.orderClassification).toBe("first_order");

    // A second purchase dated after the first should be classified "recurring".
    const purchase2 = await agent
      .post(`/api/app/customers/${customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-03-01", orderNumber: "ORD-2", productName: "Widget 2", amountPaid: "19.99" });
    expect(purchase2.status).toBe(201);
    expect(purchase2.body.purchase.orderClassification).toBe("recurring");

    const detailRes = await agent.get(`/api/app/customers/${customer.id}`);
    expect(detailRes.body.purchases).toHaveLength(2);
  });

  it("search finds customers by name/email, and list includes purchase aggregates", async () => {
    await seedUser("admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin2@example.com");

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Zoltan", lastName: "Searchable", email: "zoltan@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = createRes.body.customer.id;
    await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-Z1", productName: "Thing", amountPaid: "100.00" });

    const searchRes = await agent.get("/api/app/customers").query({ search: "Zoltan" });
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.customers).toHaveLength(1);
    expect(searchRes.body.customers[0].purchaseCount).toBe(1);
    expect(searchRes.body.customers[0].totalPaid).toBe("100.00");

    const noMatch = await agent.get("/api/app/customers").query({ search: "no-such-customer-xyz" });
    expect(noMatch.body.customers).toHaveLength(0);
    expect(noMatch.body.total).toBe(0);
  });

  it("returns 404 for an unknown customer id", async () => {
    await seedUser("admin3@example.com", "admin");
    const { agent } = await loginAgent(app, "admin3@example.com");
    const res = await agent.get("/api/app/customers/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("filters by leadType, purchaseStatus, and questionnaireId", async () => {
    await seedUser("admin6@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin6@example.com");

    const purchaser = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Filt", lastName: "Purchaser", email: "filt-purchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "Referral Filter Test" });
    await agent
      .post(`/api/app/customers/${purchaser.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-FILT-1", productName: "Thing", amountPaid: "10.00" });

    const nonPurchaser = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Filt", lastName: "NonPurchaser", email: "filt-nonpurchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "Referral Filter Test" });

    const byLeadType = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test" });
    expect(byLeadType.body.total).toBe(2);

    const purchasedOnly = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "purchased" });
    expect(purchasedOnly.body.total).toBe(1);
    expect(purchasedOnly.body.customers[0].id).toBe(purchaser.body.customer.id);

    const notPurchasedOnly = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "not_purchased" });
    expect(notPurchasedOnly.body.total).toBe(1);
    expect(notPurchasedOnly.body.customers[0].id).toBe(nonPurchaser.body.customer.id);

    // A lead whose only purchase is classified "recurring" must land in
    // not_purchased, not purchased — same rule as the summary tiles.
    const recurringOnlyLead = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Filt", lastName: "RecurringOnly", email: "filt-recurring-only@example.com", leadReceivedDate: "2026-01-01", leadType: "Referral Filter Test" });
    const recurringOnlyPurchase = await agent
      .post(`/api/app/customers/${recurringOnlyLead.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-FILT-RECURRING", productName: "Thing", amountPaid: "10.00" });
    await agent
      .patch(`/api/app/purchases/${recurringOnlyPurchase.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "recurring" });

    const notPurchasedWithRecurring = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "not_purchased" });
    expect(notPurchasedWithRecurring.body.total).toBe(2);
    expect(notPurchasedWithRecurring.body.customers.map((c: { id: string }) => c.id).sort()).toEqual(
      [nonPurchaser.body.customer.id, recurringOnlyLead.body.customer.id].sort(),
    );

    const purchasedStillExcludesRecurring = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "purchased" });
    expect(purchasedStillExcludesRecurring.body.total).toBe(1);
    expect(purchasedStillExcludesRecurring.body.customers[0].id).toBe(purchaser.body.customer.id);

    // The row-level badge date (qualifyingPurchaseDate) is null for the
    // recurring-only lead even though it has purchase history.
    const allThree = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test" });
    const recurringOnlyRow = allThree.body.customers.find((c: { id: string }) => c.id === recurringOnlyLead.body.customer.id);
    expect(recurringOnlyRow.qualifyingPurchaseDate).toBeNull();
    expect(recurringOnlyRow.purchaseCount).toBe(1); // still visible in full order history

    // questionnaireId filter + the status field still being surfaced on the list itself
    const { db, questionnaireEventsTable } = await import("@luma/db");
    await db.insert(questionnaireEventsTable).values({
      personId: nonPurchaser.body.customer.id,
      questionnaireId: "Q-FILT-1",
      status: "abandoned",
      lastEventAt: new Date(),
    });
    const byQuestionnaireId = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", questionnaireId: "Q-FILT-1" });
    expect(byQuestionnaireId.body.total).toBe(1);
    expect(byQuestionnaireId.body.customers[0].id).toBe(nonPurchaser.body.customer.id);
    expect(byQuestionnaireId.body.customers[0].questionnaireStatus).toBe("abandoned");

    // A different questionnaire ID shouldn't match this customer's event.
    const byOtherQuestionnaireId = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", questionnaireId: "Q-DOES-NOT-EXIST" });
    expect(byOtherQuestionnaireId.body.total).toBe(0);
  });

  it("filters by leadReceivedDate range (dateFrom/dateTo), and sorts by leadReceivedDate/lastName", async () => {
    await seedUser("admin-daterange@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-daterange@example.com");

    const jan = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Aaron", lastName: "Alpha", email: "date-jan@example.com", leadReceivedDate: "2026-01-01", leadType: "Date Range Test" });
    const feb = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Zed", lastName: "Bravo", email: "date-feb@example.com", leadReceivedDate: "2026-02-15", leadType: "Date Range Test" });
    const mar = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Mia", lastName: "Charlie", email: "date-mar@example.com", leadReceivedDate: "2026-03-01", leadType: "Date Range Test" });

    const rangeRes = await agent
      .get("/api/app/customers")
      .query({ leadType: "Date Range Test", dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    expect(rangeRes.body.total).toBe(1);
    expect(rangeRes.body.customers[0].id).toBe(feb.body.customer.id);

    const fromOnlyRes = await agent.get("/api/app/customers").query({ leadType: "Date Range Test", dateFrom: "2026-02-01" });
    expect(fromOnlyRes.body.total).toBe(2);
    expect(fromOnlyRes.body.customers.map((c: { id: string }) => c.id).sort()).toEqual([feb.body.customer.id, mar.body.customer.id].sort());

    const sortedByDate = await agent
      .get("/api/app/customers")
      .query({ leadType: "Date Range Test", sortBy: "leadReceivedDate", sortDir: "asc" });
    expect(sortedByDate.body.customers.map((c: { id: string }) => c.id)).toEqual([jan.body.customer.id, feb.body.customer.id, mar.body.customer.id]);

    const sortedByLastName = await agent
      .get("/api/app/customers")
      .query({ leadType: "Date Range Test", sortBy: "lastName", sortDir: "asc" });
    expect(sortedByLastName.body.customers.map((c: { id: string }) => c.id)).toEqual([jan.body.customer.id, feb.body.customer.id, mar.body.customer.id]);
  });
});

describe("Customers summary", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("computes totals, purchased/not-purchased split, and conversion rate", async () => {
    await seedUser("admin-summary@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-summary@example.com");

    const purchaser = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "Purchaser", email: "sum-purchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "web-form" });
    await agent
      .post(`/api/app/customers/${purchaser.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-SUM-1", productName: "Thing", amountPaid: "10.00" });

    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "NonPurchaser", email: "sum-nonpurchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "Bask abandoned cart" });

    const res = await agent.get("/api/app/customers/summary").query({ period: "all" });
    expect(res.status).toBe(200);
    expect(res.body.totalLeads).toBeGreaterThanOrEqual(2);
    expect(res.body.purchased).toBeGreaterThanOrEqual(1);
    expect(res.body.notPurchased).toBe(res.body.totalLeads - res.body.purchased);
    expect(res.body.conversionRate).toBeGreaterThan(0);
  });

  it("does not count a recurring-only purchase as 'purchased' — only a completed first-order purchase converts a lead", async () => {
    await seedUser("admin-summary-recurring@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-summary-recurring@example.com");

    const before = await agent.get("/api/app/customers/summary").query({ period: "all" });

    // Lead whose first purchase is a real first_order — should count.
    const converted = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Rec", lastName: "Converted", email: "rec-converted@example.com", leadReceivedDate: "2026-01-01" });
    await agent
      .post(`/api/app/customers/${converted.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-REC-1", productName: "Thing", amountPaid: "10.00" });

    // Lead whose only purchase is classified "recurring" (e.g. a backfilled
    // order) — must NOT count as purchased, mirroring Marketing CPA's rule.
    const recurringOnly = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Rec", lastName: "OnlyRecurring", email: "rec-only-recurring@example.com", leadReceivedDate: "2026-01-01" });
    const recurringPurchase = await agent
      .post(`/api/app/customers/${recurringOnly.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-REC-2", productName: "Thing", amountPaid: "10.00" });
    await agent
      .patch(`/api/app/purchases/${recurringPurchase.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "recurring" });

    const after = await agent.get("/api/app/customers/summary").query({ period: "all" });
    expect(after.body.totalLeads - before.body.totalLeads).toBe(2); // both leads are in scope
    expect(after.body.purchased - before.body.purchased).toBe(1); // only the first_order one converts
  });

  it("classifies leads into metaFormFillCount/questionnaireCount by first-touch source, no double-counting", async () => {
    await seedUser("admin-source@example.com", "admin");
    const { agent } = await loginAgent(app, "admin-source@example.com");

    const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
    const [ghlLead] = await db
      .insert(customersTable)
      .values({ firstName: "GHL", lastName: "Sourced", email: "ghl-sourced@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(externalIdentitiesTable).values({ personId: ghlLead!.id, system: "ghl", externalId: "ghl-src-1" });

    const [baskLead] = await db
      .insert(customersTable)
      .values({ firstName: "Bask", lastName: "Sourced", email: "bask-sourced@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(externalIdentitiesTable).values({ personId: baskLead!.id, system: "bask", externalId: "bask-src-1" });

    // Touched by GHL first, then later also by Bask — must still count once, under GHL.
    const [bothLead] = await db
      .insert(customersTable)
      .values({ firstName: "Both", lastName: "Sourced", email: "both-sourced@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db
      .insert(externalIdentitiesTable)
      .values({ personId: bothLead!.id, system: "ghl", externalId: "both-src-ghl", createdAt: new Date("2026-01-01T00:00:00Z") });
    await db
      .insert(externalIdentitiesTable)
      .values({ personId: bothLead!.id, system: "bask", externalId: "both-src-bask", createdAt: new Date("2026-01-02T00:00:00Z") });

    const res = await agent.get("/api/app/customers/summary").query({ period: "all" });
    expect(res.status).toBe(200);
    expect(res.body.metaFormFillCount).toBeGreaterThanOrEqual(2); // ghlLead + bothLead
    expect(res.body.questionnaireCount).toBeGreaterThanOrEqual(1); // baskLead only
    expect(res.body.metaFormFillCount + res.body.questionnaireCount).toBeLessThanOrEqual(res.body.totalLeads);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/summary");
    expect(res.status).toBe(401);
  });
});

describe("Customers lead-types", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns distinct lead types", async () => {
    await seedUser("admin-leadtypes@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-leadtypes@example.com");

    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "LT", lastName: "One", email: "lt-one@example.com", leadReceivedDate: "2026-01-01", leadType: "Distinct Lead Type Test" });
    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "LT", lastName: "Two", email: "lt-two@example.com", leadReceivedDate: "2026-01-01", leadType: "Distinct Lead Type Test" });

    const res = await agent.get("/api/app/customers/lead-types");
    expect(res.status).toBe(200);
    const occurrences = res.body.leadTypes.filter((lt: string) => lt === "Distinct Lead Type Test");
    expect(occurrences).toHaveLength(1); // distinct, not once per customer
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/lead-types");
    expect(res.status).toBe(401);
  });
});

describe("Customers questionnaire-ids", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns distinct questionnaire IDs, not statuses", async () => {
    await seedUser("admin-qids@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-qids@example.com");

    const one = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Q", lastName: "One", email: "q-one@example.com", leadReceivedDate: "2026-01-01" });
    const two = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Q", lastName: "Two", email: "q-two@example.com", leadReceivedDate: "2026-01-01" });

    const { db, questionnaireEventsTable } = await import("@luma/db");
    await db.insert(questionnaireEventsTable).values([
      { personId: one.body.customer.id, questionnaireId: "Q-DISTINCT-9914", status: "submitted", lastEventAt: new Date() },
      { personId: two.body.customer.id, questionnaireId: "Q-DISTINCT-9914", status: "abandoned", lastEventAt: new Date() },
    ]);

    const res = await agent.get("/api/app/customers/questionnaire-ids");
    expect(res.status).toBe(200);
    const occurrences = res.body.questionnaireIds.filter((qid: string) => qid === "Q-DISTINCT-9914");
    expect(occurrences).toHaveLength(1); // distinct, not once per event/customer
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/questionnaire-ids");
    expect(res.status).toBe(401);
  });
});

describe("Purchases", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("admin can update classification, which writes an audit row", async () => {
    await seedUser("admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin4@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Purch", lastName: "Aser", email: "purchaser@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    const purchaseRes = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-10", orderNumber: "ORD-X", productName: "Gadget", amountPaid: "75.00" });
    const purchaseId = purchaseRes.body.purchase.id;
    expect(purchaseRes.body.purchase.orderClassification).toBe("first_order");

    const updateRes = await agent
      .patch(`/api/app/purchases/${purchaseId}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "recurring" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.purchase.orderClassification).toBe("recurring");
    expect(updateRes.body.purchase.orderClassificationSource).toBe("manual");

    const { db, purchaseClassificationAuditsTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const audits = await db
      .select()
      .from(purchaseClassificationAuditsTable)
      .where(eq(purchaseClassificationAuditsTable.purchaseId, purchaseId));
    expect(audits).toHaveLength(1);
    expect(audits[0].previousClassification).toBe("first_order");
    expect(audits[0].newClassification).toBe("recurring");
    expect(audits[0].changedBy).toBe("admin4@example.com");
  });

  it("returns 404 for an unknown purchase id", async () => {
    await seedUser("admin5@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin5@example.com");
    const res = await agent.patch("/api/app/purchases/999999999").set("x-csrf-token", csrf).send({ status: "refunded" });
    expect(res.status).toBe(404);
  });

  it("lists purchases across all customers with the customer's name attached", async () => {
    await seedUser("admin-orders@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-orders@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Order", lastName: "Placer", email: "order-placer@example.com", leadReceivedDate: "2026-01-01" });
    await agent
      .post(`/api/app/customers/${customerRes.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-10", orderNumber: "ORD-LIST-1", productName: "Gizmo", amountPaid: "25.00" });

    // limit:100 (the max) rather than a small page size — this shared test DB
    // accumulates purchase rows from other test files running concurrently in
    // the same schema, so a small limit risks this test's own row falling off
    // the page purely due to how many other purchases happen to sort above it.
    const res = await agent.get("/api/app/purchases").query({ limit: 100 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const row = res.body.purchases.find((p: { orderNumber: string }) => p.orderNumber === "ORD-LIST-1");
    expect(row.customerFirstName).toBe("Order");
    expect(row.customerLastName).toBe("Placer");
  });

  it("filters by orderClassification (first_order vs recurring)", async () => {
    await seedUser("admin-order-class-filter@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-order-class-filter@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Class", lastName: "Filter", email: "class-filter@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    const firstOrder = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-CLASS-1", productName: "Thing", amountPaid: "10.00" });
    expect(firstOrder.body.purchase.orderClassification).toBe("first_order");

    const recurringOrder = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-02", orderNumber: "ORD-CLASS-2", productName: "Thing", amountPaid: "20.00" });
    expect(recurringOrder.body.purchase.orderClassification).toBe("recurring");

    const firstOnly = await agent.get("/api/app/purchases").query({ orderClassification: "first_order", limit: 100 });
    expect(firstOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-1")).toBe(true);
    expect(firstOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-2")).toBe(false);

    const recurringOnly = await agent.get("/api/app/purchases").query({ orderClassification: "recurring", limit: 100 });
    expect(recurringOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-2")).toBe(true);
    expect(recurringOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-1")).toBe(false);
  });

  it("rejects unauthenticated requests to the purchases list", async () => {
    const res = await request(app).get("/api/app/purchases");
    expect(res.status).toBe(401);
  });

  it("computes purchasing/new/recurring customer counts and revenue, completed orders only", async () => {
    await seedUser("admin-orders-summary@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-orders-summary@example.com");

    const repeat = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "Repeat", email: "sum-repeat@example.com", leadReceivedDate: "2026-01-01" });
    const firstOrder = await agent
      .post(`/api/app/customers/${repeat.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-SUM-1", productName: "Thing", amountPaid: "10.00" });
    expect(firstOrder.body.purchase.orderClassification).toBe("first_order");
    const secondOrder = await agent
      .post(`/api/app/customers/${repeat.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-02", orderNumber: "ORD-SUM-2", productName: "Thing", amountPaid: "20.00" });
    expect(secondOrder.body.purchase.orderClassification).toBe("recurring");

    // A cancelled purchase should not count toward completed-only totals.
    const oneOff = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "Cancelled", email: "sum-cancelled@example.com", leadReceivedDate: "2026-01-01" });
    const cancelledPurchase = await agent
      .post(`/api/app/customers/${oneOff.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-SUM-3", productName: "Thing", amountPaid: "999.00" });
    await agent
      .patch(`/api/app/purchases/${cancelledPurchase.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ status: "cancelled" });

    const res = await agent.get("/api/app/purchases/summary").query({ period: "all" });
    expect(res.status).toBe(200);
    expect(res.body.purchasingCustomers).toBeGreaterThanOrEqual(1);
    expect(res.body.newCustomers).toBeGreaterThanOrEqual(1);
    expect(res.body.recurringCustomers).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.totalRevenue)).toBeGreaterThanOrEqual(30);
    // The $999 cancelled purchase must not be counted.
    expect(res.body.totalRevenue).not.toContain("999");
  });

  it("rejects unauthenticated requests to the purchases summary", async () => {
    const res = await request(app).get("/api/app/purchases/summary");
    expect(res.status).toBe(401);
  });
});

describe("Intake link", () => {
  let app: ReturnType<typeof createApp>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    process.env.BASK_QUESTIONNAIRE_URL = "https://bask.example.com/questionnaire";
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("manager can generate a signup link for a lead", async () => {
    await seedUser("intake-manager1@example.com", "manager");
    const { agent, csrf } = await loginAgent(app, "intake-manager1@example.com");

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Intake", lastName: "Lead", email: "intake1@example.com", leadReceivedDate: "2026-08-15" });
    // Manager can't create (admin-only) — seed via a fresh admin instead.
    expect(createRes.status).toBe(403);

    await seedUser("intake-admin1@example.com", "admin");
    const adminAgent = await loginAgent(app, "intake-admin1@example.com");
    const customerRes = await adminAgent.agent
      .post("/api/app/customers")
      .set("x-csrf-token", adminAgent.csrf)
      .send({ firstName: "Intake", lastName: "Lead", email: "intake2@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const res = await agent.post(`/api/app/customers/${customerId}/intake-link`).set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^http:\/\/localhost:3000\/go\/.+/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects employee role", async () => {
    await seedUser("intake-admin2@example.com", "admin");
    const admin = await loginAgent(app, "intake-admin2@example.com");
    const customerRes = await admin.agent
      .post("/api/app/customers")
      .set("x-csrf-token", admin.csrf)
      .send({ firstName: "Intake", lastName: "Lead", email: "intake3@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    await seedUser("intake-employee1@example.com", "employee");
    const { agent, csrf } = await loginAgent(app, "intake-employee1@example.com");
    const res = await agent.post(`/api/app/customers/${customerId}/intake-link`).set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown customer id", async () => {
    await seedUser("intake-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "intake-admin3@example.com");
    const res = await agent
      .post("/api/app/customers/00000000-0000-0000-0000-000000000000/intake-link")
      .set("x-csrf-token", csrf)
      .send({});
    expect(res.status).toBe(404);
  });
});
