import { describe, expect, it, beforeAll } from "vitest";
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

  it("filters by leadType, purchaseStatus, and questionnaireStatus", async () => {
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

    // questionnaireStatus filter + the field being surfaced on the list itself
    const { db, questionnaireEventsTable } = await import("@luma/db");
    await db.insert(questionnaireEventsTable).values({
      personId: nonPurchaser.body.customer.id,
      questionnaireId: "Q-FILT-1",
      status: "abandoned",
      lastEventAt: new Date(),
    });
    const byQuestionnaireStatus = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", questionnaireStatus: "abandoned" });
    expect(byQuestionnaireStatus.body.total).toBe(1);
    expect(byQuestionnaireStatus.body.customers[0].id).toBe(nonPurchaser.body.customer.id);
    expect(byQuestionnaireStatus.body.customers[0].questionnaireStatus).toBe("abandoned");
  });
});

describe("Customers summary", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("computes totals, purchased/not-purchased split, conversion rate, and lead-type breakdown", async () => {
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
    expect(Array.isArray(res.body.leadTypeBreakdown)).toBe(true);
    const webFormRow = res.body.leadTypeBreakdown.find((r: { leadType: string }) => r.leadType === "web-form");
    expect(webFormRow.count).toBeGreaterThanOrEqual(1);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/summary");
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

    const res = await agent.get("/api/app/purchases").query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const row = res.body.purchases.find((p: { orderNumber: string }) => p.orderNumber === "ORD-LIST-1");
    expect(row.customerFirstName).toBe("Order");
    expect(row.customerLastName).toBe("Placer");
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
