import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";

const GHL_SECRET = "test-ghl-secret";
const ORDER_SECRET = "test-order-secret";
const QUESTIONNAIRE_SECRET = "test-questionnaire-secret";
const PAYMENT_FAILED_SECRET = "test-payment-failed-secret";

describe("Webhooks", () => {
  let app: ReturnType<typeof createApp>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.GHL_WEBHOOK_SECRET = GHL_SECRET;
    process.env.ORDER_WEBHOOK_SECRET = ORDER_SECRET;
    process.env.QUESTIONNAIRE_WEBHOOK_SECRET = QUESTIONNAIRE_SECRET;
    process.env.FAILED_PAYMENT_WEBHOOK_SECRET = PAYMENT_FAILED_SECRET;
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("Auth", () => {
    it("rejects a missing secret with 401", async () => {
      const res = await request(app).post("/api/webhooks/ghl-lead").send({});
      expect(res.status).toBe(401);
    });

    it("rejects a wrong secret with 401", async () => {
      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", "wrong").send({});
      expect(res.status).toBe(401);
    });

    it("returns 500 if the env var itself is unset", async () => {
      const saved = process.env.GHL_WEBHOOK_SECRET;
      delete process.env.GHL_WEBHOOK_SECRET;
      const localApp = createApp();
      const res = await request(localApp).post("/api/webhooks/ghl-lead").set("x-webhook-secret", "anything").send({});
      expect(res.status).toBe(500);
      process.env.GHL_WEBHOOK_SECRET = saved;
    });
  });

  describe("GHL lead", () => {
    it("creates a new customer, and is idempotent on eventId replay", async () => {
      const payload = {
        eventId: "ghl-evt-1",
        contactId: "ghl-contact-1",
        firstName: "Lead",
        lastName: "One",
        email: "lead1@example.com",
        phone: "+12025550111",
        occurredAt: new Date().toISOString(),
      };

      const first = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(first.status).toBe(200);
      expect(first.body.duplicate).toBe(false);

      const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "lead1@example.com"));
      expect(customer).toBeTruthy();
      const [identity] = await db
        .select()
        .from(externalIdentitiesTable)
        .where(eq(externalIdentitiesTable.externalId, "ghl-contact-1"));
      expect(identity.personId).toBe(customer.id);

      // Replay the same eventId — must not create a second customer.
      const replay = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(replay.status).toBe(200);
      expect(replay.body.duplicate).toBe(true);

      const allWithEmail = await db.select().from(customersTable).where(eq(customersTable.email, "lead1@example.com"));
      expect(allWithEmail).toHaveLength(1);
    });

    it("rejects an invalid payload with 400", async () => {
      const res = await request(app)
        .post("/api/webhooks/ghl-lead")
        .set("x-webhook-secret", GHL_SECRET)
        .send({ eventId: "bad" }); // missing required fields
      expect(res.status).toBe(400);
    });
  });

  describe("Bask order", () => {
    it("matches an existing customer by external identity and classifies purchases", async () => {
      const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Order", lastName: "Match", email: "orderer@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-1" });

      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-1",
          externalPersonId: "bask-person-1",
          email: "orderer@example.com",
          orderNumber: "BASK-1",
          productName: "Program",
          amountPaid: "199.00",
          purchaseDate: "2026-02-01",
          occurredAt: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases).toHaveLength(1);
      expect(purchases[0].orderClassification).toBe("first_order");
      expect(purchases[0].orderClassificationSource).toBe("bask");
    });

    it("creates a new customer when no match exists", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-2",
          externalPersonId: "bask-person-new",
          email: "neworderer@example.com",
          firstName: "New",
          lastName: "Orderer",
          orderNumber: "BASK-2",
          productName: "Program",
          amountPaid: "99.00",
          purchaseDate: "2026-02-05",
          occurredAt: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "neworderer@example.com"));
      expect(customer).toBeTruthy();
    });
  });

  describe("Bask questionnaire", () => {
    it("upserts questionnaire status idempotently on the same questionnaireId", async () => {
      const payload = {
        eventId: "bask-q-evt-1",
        externalPersonId: "bask-person-q1",
        email: "questionnaire1@example.com",
        firstName: "Q",
        lastName: "One",
        questionnaireId: "QUEST-1",
        status: "started" as const,
        occurredAt: new Date().toISOString(),
      };
      const first = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(first.status).toBe(200);

      const { db, questionnaireEventsTable, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "questionnaire1@example.com"));
      let rows = await db.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.personId, customer!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("started");

      // Same questionnaireId, different eventId (a second lifecycle event) -> updates the existing row, not a new one.
      const second = await request(app)
        .post("/api/webhooks/bask-questionnaire")
        .set("x-webhook-secret", QUESTIONNAIRE_SECRET)
        .send({ ...payload, eventId: "bask-q-evt-2", status: "abandoned" as const });
      expect(second.status).toBe(200);

      rows = await db.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.personId, customer!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("abandoned");
      expect(rows[0].abandonedAt).not.toBeNull();
    });
  });

  describe("Bask payment-failed", () => {
    it("records the event, linking to a matched customer when found", async () => {
      const { db, customersTable, externalIdentitiesTable, failedPaymentEventsTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Fail", lastName: "Payment", email: "failpay@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-fp1" });

      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-1",
          transactionId: "txn-1",
          externalPersonId: "bask-person-fp1",
          amount: "49.99",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const rows = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.transactionId, "txn-1"));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).toBe(customer!.id);
    });

    it("records the event with a null personId when no customer can be matched, without creating one", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-2",
          transactionId: "txn-2",
          externalPersonId: "bask-person-unknown",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const { db, failedPaymentEventsTable, externalIdentitiesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.transactionId, "txn-2"));
      expect(row.personId).toBeNull();

      // No customer/identity should have been created for the unmatched externalPersonId.
      const identities = await db
        .select()
        .from(externalIdentitiesTable)
        .where(eq(externalIdentitiesTable.externalId, "bask-person-unknown"));
      expect(identities).toHaveLength(0);
    });
  });
});
