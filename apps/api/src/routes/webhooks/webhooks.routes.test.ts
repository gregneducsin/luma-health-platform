import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";

const GHL_SECRET = "test-ghl-secret";
const ORDER_SECRET = "test-order-secret";
const QUESTIONNAIRE_SECRET = "test-questionnaire-secret";
const PAYMENT_FAILED_SECRET = "test-payment-failed-secret";

const sendMessageMock = vi.fn();
vi.mock("../../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sms-provider.js")>("../../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

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

    it("persists the payload's leadType onto the created customer", async () => {
      const payload = {
        eventId: "ghl-evt-leadtype",
        contactId: "ghl-contact-leadtype",
        firstName: "Lead",
        lastName: "Typed",
        email: "leadtype@example.com",
        leadType: "web-form",
        occurredAt: new Date().toISOString(),
      };

      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "leadtype@example.com"));
      expect(customer.leadType).toBe("web-form");
    });

    it("defaults occurredAt to now when the source doesn't provide one", async () => {
      const payload = {
        eventId: "ghl-evt-no-timestamp",
        contactId: "ghl-contact-no-timestamp",
        firstName: "No",
        lastName: "Timestamp",
        email: "ghl-no-timestamp@example.com",
        // occurredAt intentionally omitted
      };
      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "ghl-no-timestamp@example.com"));
      expect(customer.leadReceivedDate).toBe(new Date().toISOString().slice(0, 10));
    });

    it("fires the meta-lead opener instantly for leadType 'Meta Form Fill'", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_meta_webhook" });

      const payload = {
        eventId: "ghl-evt-meta-1",
        contactId: "ghl-contact-meta-1",
        firstName: "Meta",
        lastName: "Lead",
        email: "meta-lead-webhook@example.com",
        phone: "+15557770000",
        leadType: "Meta Form Fill",
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(res.status).toBe(200);

      expect(sendMessageMock).toHaveBeenCalledWith("+15557770000", expect.stringContaining("what state you're in"));

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "meta-lead-webhook@example.com"));
      const { getOrCreateConversation, listMessages } = await import("../../services/conversations.service.js");
      const conversation = await getOrCreateConversation(customer!.id);
      expect(conversation.leadSource).toBe("meta_form");
      const messages = await listMessages(conversation.id);
      expect(messages.length).toBe(1);
    });

    it("matches leadType case-insensitively and does not fire the opener for other lead types", async () => {
      sendMessageMock.mockClear();

      const res = await request(app)
        .post("/api/webhooks/ghl-lead")
        .set("x-webhook-secret", GHL_SECRET)
        .send({
          eventId: "ghl-evt-not-meta",
          contactId: "ghl-contact-not-meta",
          firstName: "Other",
          lastName: "Lead",
          email: "not-meta-lead@example.com",
          leadType: "web-form",
          occurredAt: new Date().toISOString(),
        });
      expect(res.status).toBe(200);
      expect(sendMessageMock).not.toHaveBeenCalled();
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

    it("schedules an abandoned-cart opener trigger on status=abandoned, idempotently on redelivery", async () => {
      const payload = {
        eventId: "bask-q-evt-abandon-trigger-1",
        externalPersonId: "bask-person-abandon-trigger",
        email: "abandon-trigger@example.com",
        firstName: "Trigger",
        lastName: "Test",
        questionnaireId: "QUEST-TRIGGER-1",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const first = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(first.status).toBe(200);

      const { db, customersTable, abandonedCartTriggersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "abandon-trigger@example.com"));
      let triggers = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, customer!.id));
      expect(triggers).toHaveLength(1);
      expect(triggers[0].status).toBe("pending");

      // A retried delivery of the same event is a no-op replay (idempotent on eventId)
      // and doesn't reach the trigger-scheduling code a second time.
      const redelivery = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(redelivery.status).toBe(200);
      expect(redelivery.body.duplicate).toBe(true);

      triggers = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, customer!.id));
      expect(triggers).toHaveLength(1);
    });

    it("categorizes a customer created directly from an abandoned questionnaire (no prior GHL lead)", async () => {
      const payload = {
        eventId: "bask-q-evt-abandoned-only",
        externalPersonId: "bask-person-abandoned-only",
        email: "abandoned-cart@example.com",
        firstName: "Cart",
        lastName: "Abandoner",
        questionnaireId: "QUEST-2",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "abandoned-cart@example.com"));
      expect(customer.leadType).toBe("Bask abandoned cart");
    });

    it("persists the payload's phone onto the created customer", async () => {
      const payload = {
        eventId: "bask-q-evt-phone",
        externalPersonId: "bask-person-phone",
        email: "phone-test@example.com",
        firstName: "Phone",
        lastName: "Tester",
        phone: "+15551234567",
        questionnaireId: "QUEST-3",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "phone-test@example.com"));
      expect(customer.phone).toBe("+15551234567");
    });

    it("defaults occurredAt to now when the source doesn't provide one", async () => {
      const payload = {
        eventId: "bask-q-evt-no-timestamp",
        externalPersonId: "bask-person-no-timestamp",
        email: "no-timestamp@example.com",
        questionnaireId: "QUEST-4",
        status: "abandoned" as const,
        // occurredAt intentionally omitted
      };
      const before = Date.now();
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable, questionnaireEventsTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "no-timestamp@example.com"));
      const [event] = await db
        .select()
        .from(questionnaireEventsTable)
        .where(eq(questionnaireEventsTable.personId, customer!.id));
      expect(event.lastEventAt!.getTime()).toBeGreaterThanOrEqual(before);
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
