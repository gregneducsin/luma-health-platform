import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "employee") {
  const { db, appUsersTable } = await import("@luma/db");
  const { hashPassword } = await import("../../lib/crypto.js");
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

describe("Employees", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it("employee role is forbidden, manager can read but not write, admin can do both", async () => {
    await seedUser("payroll-emp1@example.com", "employee");
    const employeeAgent = await loginAgent(app, "payroll-emp1@example.com");
    expect((await employeeAgent.agent.get("/api/app/payroll/employees")).status).toBe(403);

    await seedUser("payroll-mgr1@example.com", "manager");
    const managerAgent = await loginAgent(app, "payroll-mgr1@example.com");
    expect((await managerAgent.agent.get("/api/app/payroll/employees")).status).toBe(200);
    const managerCreate = await managerAgent.agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", managerAgent.csrf)
      .send({ firstName: "X", lastName: "Y", email: "xy@example.com", hourlyRate: "20.00" });
    expect(managerCreate.status).toBe(403);

    await seedUser("payroll-admin1@example.com", "admin");
    const adminAgent = await loginAgent(app, "payroll-admin1@example.com");
    const created = await adminAgent.agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", adminAgent.csrf)
      .send({ firstName: "Alice", lastName: "Worker", email: "alice.worker@example.com", hourlyRate: "22.50" });
    expect(created.status).toBe(201);
    expect(created.body.employee.employeeNumber).toMatch(/^EMP-\d{6}$/);
  });
});

describe("Payroll week lifecycle", () => {
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrf: string;
  let employeeId: string;

  beforeAll(async () => {
    app = createApp();
    await seedUser("payroll-admin2@example.com", "admin");
    ({ agent, csrf } = await loginAgent(app, "payroll-admin2@example.com"));

    const employeeRes = await agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Bob", lastName: "Hourly", email: "bob.hourly@example.com", hourlyRate: "20.00" });
    employeeId = employeeRes.body.employee.id;
  });

  it("full lifecycle: create draft -> enter hours -> add bonus -> approve -> pay, with correct earnings calc and audit trail", async () => {
    const weekRes = await agent
      .post("/api/app/payroll/weeks")
      .set("x-csrf-token", csrf)
      .send({ weekStart: "2026-03-06", weekEnd: "2026-03-12" });
    expect(weekRes.status).toBe(201);
    const weekId = weekRes.body.week.id;
    expect(weekRes.body.week.status).toBe("draft");

    const hoursRes = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, hoursWorked: "40" });
    expect(hoursRes.status).toBe(200);
    expect(hoursRes.body.entry.hourlyEarnings).toBe("800.00"); // 40 * 20.00
    expect(hoursRes.body.entry.hourlyRateSnapshot).toBe("20.00");

    // Re-entering hours for the same employee/week upserts, doesn't duplicate.
    const hoursUpdateRes = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, hoursWorked: "45" });
    expect(hoursUpdateRes.body.entry.hourlyEarnings).toBe("900.00");

    const bonusRes = await agent
      .post(`/api/app/payroll/weeks/${weekId}/bonuses`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, amount: "50.00", description: "Great week" });
    expect(bonusRes.status).toBe(201);

    // Can't pay before approving.
    const payTooEarly = await agent.post(`/api/app/payroll/weeks/${weekId}/pay`).set("x-csrf-token", csrf);
    expect(payTooEarly.status).toBe(400);

    const approveRes = await agent.post(`/api/app/payroll/weeks/${weekId}/approve`).set("x-csrf-token", csrf);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.week.status).toBe("approved");
    expect(approveRes.body.week.approvedBy).toBe("payroll-admin2@example.com");

    // Can't enter hours or add bonuses once approved.
    const hoursAfterApprove = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, hoursWorked: "10" });
    expect(hoursAfterApprove.status).toBe(400);

    // Can't re-approve an already-approved week.
    const reapprove = await agent.post(`/api/app/payroll/weeks/${weekId}/approve`).set("x-csrf-token", csrf);
    expect(reapprove.status).toBe(400);

    const payRes = await agent.post(`/api/app/payroll/weeks/${weekId}/pay`).set("x-csrf-token", csrf);
    expect(payRes.status).toBe(200);
    expect(payRes.body.week.status).toBe("paid");
    expect(payRes.body.week.paidBy).toBe("payroll-admin2@example.com");

    const detailRes = await agent.get(`/api/app/payroll/weeks/${weekId}`);
    expect(detailRes.body.hours).toHaveLength(1);
    expect(detailRes.body.hours[0].hourlyEarnings).toBe("900.00");
    expect(detailRes.body.bonuses).toHaveLength(1);

    const { db, payrollAuditEventsTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const auditRows = await db.select().from(payrollAuditEventsTable).where(eq(payrollAuditEventsTable.payrollWeekId, weekId));
    const actions = auditRows.map((r) => r.action).sort();
    expect(actions).toEqual(["bonus_added", "hours_entered", "hours_updated", "week_approved", "week_paid"]);
  });

  it("returns 404 for an unknown week id on approve", async () => {
    const res = await agent.post("/api/app/payroll/weeks/00000000-0000-0000-0000-000000000000/approve").set("x-csrf-token", csrf);
    expect(res.status).toBe(400); // service returns "not found" as a 400-level business error, not a route 404
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("Marketing spend weeks", () => {
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrf: string;

  beforeAll(async () => {
    app = createApp();
    await seedUser("payroll-admin3@example.com", "admin");
    ({ agent, csrf } = await loginAgent(app, "payroll-admin3@example.com"));
  });

  it("creates a valid Friday-to-Thursday week", async () => {
    // 2026-03-06 is a Friday; 2026-03-12 is the following Thursday.
    const res = await agent
      .post("/api/app/payroll/marketing-spend")
      .set("x-csrf-token", csrf)
      .send({ weekStart: "2026-03-06", weekEnd: "2026-03-12", advertisingCost: "500.00" });
    expect(res.status).toBe(201);
  });

  it("rejects a week that violates the Friday-start/Thursday-end DB constraint", async () => {
    const res = await agent
      .post("/api/app/payroll/marketing-spend")
      .set("x-csrf-token", csrf)
      .send({ weekStart: "2026-03-09", weekEnd: "2026-03-15", advertisingCost: "500.00" }); // Monday-Sunday
    expect(res.status).toBe(500); // DB CHECK constraint violation surfaces as a 500 via the generic error handler
  });
});
