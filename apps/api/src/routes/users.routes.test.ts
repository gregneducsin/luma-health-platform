import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";

const sendEmailMock = vi.fn().mockResolvedValue({ messageId: "<invite@example.com>" });
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Luma Health" }) };
});

const { createApp } = await import("../app.js");

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "customer_service") {
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

describe("Users", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/users");
    expect(res.status).toBe(401);
  });

  it("rejects manager and customer_service roles — user management is admin-only", async () => {
    await seedUser("users-mgr@example.com", "manager");
    const manager = await loginAgent(app, "users-mgr@example.com");
    expect((await manager.agent.get("/api/app/users")).status).toBe(403);

    await seedUser("users-cs@example.com", "customer_service");
    const cs = await loginAgent(app, "users-cs@example.com");
    expect((await cs.agent.get("/api/app/users")).status).toBe(403);
  });

  it("admin invites a new user: creates the row, sends the invite email, and lists it", async () => {
    sendEmailMock.mockClear();
    await seedUser("users-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin1@example.com");

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "newhire@example.com", firstName: "New", lastName: "Hire", role: "customer_service" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "newhire@example.com", role: "customer_service", status: "invited" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmailMock.mock.calls[0];
    expect(to).toBe("newhire@example.com");
    expect(subject).toMatch(/invited/i);
    expect(html).toContain("New");
    expect(html).toContain("Customer Service");

    const listRes = await agent.get("/api/app/users");
    expect(listRes.status).toBe(200);
    expect(listRes.body.users.some((u: { email: string }) => u.email === "newhire@example.com")).toBe(true);
  });

  it("rejects a duplicate email with 409", async () => {
    await seedUser("users-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin2@example.com");

    await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "dup@example.com", firstName: "First", lastName: "One", role: "manager" });

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "dup@example.com", firstName: "Second", lastName: "One", role: "manager" });
    expect(res.status).toBe(409);
  });

  it("rejects an invalid role with 400", async () => {
    await seedUser("users-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin3@example.com");

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "bad-role@example.com", firstName: "A", lastName: "B", role: "superadmin" });
    expect(res.status).toBe(400);
  });

  it("still creates the invite even when the email send fails", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("SMTP down"));
    await seedUser("users-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin4@example.com");

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "email-fails@example.com", firstName: "A", lastName: "B", role: "customer_service" });
    expect(res.status).toBe(201);
    expect(res.body.user.status).toBe("invited");
  });
});
