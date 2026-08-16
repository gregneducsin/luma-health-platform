import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { db, customersTable } from "@luma/db";
import { createApp } from "../app.js";
import { getOrCreateConversation, appendMessage } from "../services/conversations.service.js";

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

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Route", lastName: "Convo", email: `route-convo-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("Conversations", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/conversations");
    expect(res.status).toBe(401);
  });

  it("rejects employee role", async () => {
    await seedUser("convo-emp1@example.com", "employee");
    const { agent } = await loginAgent(app, "convo-emp1@example.com");
    const res = await agent.get("/api/app/conversations");
    expect(res.status).toBe(403);
  });

  it("lists conversation summaries with the customer's name and last message", async () => {
    await seedUser("convo-manager1@example.com", "manager");
    const { agent } = await loginAgent(app, "convo-manager1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "Hi there, this is Lucy.");
    await appendMessage(conversation.id, "inbound", "yes I'm interested", { sentiment: "positive" });

    const res = await agent.get("/api/app/conversations");
    expect(res.status).toBe(200);
    const found = res.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found).toBeDefined();
    expect(found.firstName).toBe("Route");
    expect(found.lastMessagePreview).toBe("yes I'm interested");
    expect(found.lastSentiment).toBe("positive");
  });

  it("returns conversation detail with customer contact and full message history", async () => {
    await seedUser("convo-admin1@example.com", "admin");
    const { agent } = await loginAgent(app, "convo-admin1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "message one");
    await appendMessage(conversation.id, "inbound", "message two");

    const res = await agent.get(`/api/app/conversations/${conversation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.firstName).toBe("Route");
    expect(res.body.messages).toHaveLength(2);
  });

  it("returns 404 for an unknown conversation id", async () => {
    await seedUser("convo-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "convo-admin2@example.com");
    const res = await agent.get("/api/app/conversations/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("summaries and detail include needsAttention, and clear-attention resets it", async () => {
    await seedUser("convo-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "convo-admin3@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const { updateConversationState } = await import("../services/conversations.service.js");
    await updateConversationState(conversation.id, { needsAttention: true });

    const listRes = await agent.get("/api/app/conversations");
    const found = listRes.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found.needsAttention).toBe(true);

    const detailRes = await agent.get(`/api/app/conversations/${conversation.id}`);
    expect(detailRes.body.conversation.needsAttention).toBe(true);

    const clearRes = await agent.post(`/api/app/conversations/${conversation.id}/clear-attention`).set("x-csrf-token", csrf).send({});
    expect(clearRes.status).toBe(200);

    const afterRes = await agent.get(`/api/app/conversations/${conversation.id}`);
    expect(afterRes.body.conversation.needsAttention).toBe(false);
  });

  it("clear-attention returns 404 for an unknown conversation id", async () => {
    await seedUser("convo-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "convo-admin4@example.com");
    const res = await agent.post("/api/app/conversations/00000000-0000-0000-0000-000000000000/clear-attention").set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(404);
  });
});
