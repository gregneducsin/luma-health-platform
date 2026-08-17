import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";
import { db, customersTable } from "@luma/db";
import { getOrCreateSupportConversation, appendSupportMessage } from "../services/support-conversations.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { createApp } = await import("../app.js");

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "employee") {
  const { appUsersTable } = await import("@luma/db");
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

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Route",
      lastName: "Support",
      email: `route-support-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
      phone: opts.phone === undefined ? "+15556660001" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("Support conversations", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/support-conversations");
    expect(res.status).toBe(401);
  });

  it("rejects employee role", async () => {
    await seedUser("support-emp1@example.com", "employee");
    const { agent } = await loginAgent(app, "support-emp1@example.com");
    const res = await agent.get("/api/app/support-conversations");
    expect(res.status).toBe(403);
  });

  it("lists conversation summaries with the customer's name and last message", async () => {
    await seedUser("support-manager1@example.com", "manager");
    const { agent } = await loginAgent(app, "support-manager1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Hi, this is Sarah.");
    await appendSupportMessage(conversation.id, "inbound", "Thanks for the update!", { sentiment: "positive" });

    const res = await agent.get("/api/app/support-conversations");
    expect(res.status).toBe(200);
    const found = res.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found).toBeDefined();
    expect(found.firstName).toBe("Route");
    expect(found.lastMessagePreview).toBe("Thanks for the update!");
    expect(found.lastSentiment).toBe("positive");
  });

  it("returns conversation detail with customer contact and full message history", async () => {
    await seedUser("support-admin1@example.com", "admin");
    const { agent } = await loginAgent(app, "support-admin1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "message one");
    await appendSupportMessage(conversation.id, "inbound", "message two");

    const res = await agent.get(`/api/app/support-conversations/${conversation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.firstName).toBe("Route");
    expect(res.body.messages).toHaveLength(2);
  });

  it("returns 404 for an unknown conversation id", async () => {
    await seedUser("support-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "support-admin2@example.com");
    const res = await agent.get("/api/app/support-conversations/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("clear-attention resets needsAttention", async () => {
    await seedUser("support-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "support-admin3@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const { updateSupportConversationState } = await import("../services/support-conversations.service.js");
    await updateSupportConversationState(conversation.id, { needsAttention: true });

    const listRes = await agent.get("/api/app/support-conversations");
    const found = listRes.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found.needsAttention).toBe(true);

    const clearRes = await agent.post(`/api/app/support-conversations/${conversation.id}/clear-attention`).set("x-csrf-token", csrf).send({});
    expect(clearRes.status).toBe(200);

    const afterRes = await agent.get(`/api/app/support-conversations/${conversation.id}`);
    expect(afterRes.body.conversation.needsAttention).toBe(false);
  });

  it("clear-attention returns 404 for an unknown conversation id", async () => {
    await seedUser("support-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "support-admin4@example.com");
    const res = await agent.post("/api/app/support-conversations/00000000-0000-0000-0000-000000000000/clear-attention").set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(404);
  });

  describe("staff reply", () => {
    it("sends the reply, logs it, and clears needsAttention", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_route_support_reply_1" });

      await seedUser("support-reply1@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "support-reply1@example.com");

      const personId = await seedCustomer({ phone: "+15556660020" });
      const conversation = await getOrCreateSupportConversation(personId);
      const { updateSupportConversationState } = await import("../services/support-conversations.service.js");
      await updateSupportConversationState(conversation.id, { needsAttention: true });

      const res = await agent
        .post(`/api/app/support-conversations/${conversation.id}/reply`)
        .set("x-csrf-token", csrf)
        .send({ body: "Your label has the exact timing instructions." });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: true });
      expect(sendMessageMock).toHaveBeenCalledWith("+15556660020", "Your label has the exact timing instructions.");

      const detailRes = await agent.get(`/api/app/support-conversations/${conversation.id}`);
      expect(detailRes.body.conversation.needsAttention).toBe(false);
      expect(detailRes.body.messages.at(-1)).toMatchObject({ direction: "outbound", body: "Your label has the exact timing instructions." });
    });

    it("rejects an empty body with 400", async () => {
      await seedUser("support-reply2@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "support-reply2@example.com");
      const personId = await seedCustomer();
      const conversation = await getOrCreateSupportConversation(personId);

      const res = await agent.post(`/api/app/support-conversations/${conversation.id}/reply`).set("x-csrf-token", csrf).send({ body: "" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown conversation id", async () => {
      await seedUser("support-reply3@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "support-reply3@example.com");
      const res = await agent
        .post("/api/app/support-conversations/00000000-0000-0000-0000-000000000000/reply")
        .set("x-csrf-token", csrf)
        .send({ body: "hi" });
      expect(res.status).toBe(404);
    });

    it("requires authentication", async () => {
      const personId = await seedCustomer();
      const conversation = await getOrCreateSupportConversation(personId);
      const res = await request(app).post(`/api/app/support-conversations/${conversation.id}/reply`).send({ body: "hi" });
      expect(res.status).toBe(401);
    });

    it("rejects employee role", async () => {
      await seedUser("support-reply4@example.com", "employee");
      const { agent, csrf } = await loginAgent(app, "support-reply4@example.com");
      const personId = await seedCustomer();
      const conversation = await getOrCreateSupportConversation(personId);
      const res = await agent.post(`/api/app/support-conversations/${conversation.id}/reply`).set("x-csrf-token", csrf).send({ body: "hi" });
      expect(res.status).toBe(403);
    });
  });
});
