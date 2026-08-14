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
});
