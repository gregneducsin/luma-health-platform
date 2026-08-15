import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { db, customersTable, intakeLinkTokensTable, followUpJobsTable } from "@luma/db";
import { hashToken } from "../lib/crypto.js";
import { eq } from "drizzle-orm";

const originalEnv = { ...process.env };

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Test",
      lastName: "Lead",
      email: `lead-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("intake-links.service", () => {
  beforeAll(() => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    process.env.BASK_QUESTIONNAIRE_URL = "https://bask.example.com/questionnaire";
  });

  afterEach(() => {
    process.env = { ...originalEnv, INTAKE_LINK_BASE_URL: "http://localhost:3000", BASK_QUESTIONNAIRE_URL: "https://bask.example.com/questionnaire" };
  });

  describe("createIntakeLink", () => {
    it("mints a link whose token is stored only as a hash, not the raw value", async () => {
      const { createIntakeLink } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const { url, expiresAt } = await createIntakeLink(personId);

      expect(url.startsWith("http://localhost:3000/go/")).toBe(true);
      const rawToken = url.split("/go/")[1];

      const [row] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
      expect(row).toBeDefined();
      expect(row.tokenHash).toBe(hashToken(rawToken));
      expect(row.tokenHash).not.toBe(rawToken);
      expect(row.clickedAt).toBeNull();
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("throws a clear error when INTAKE_LINK_BASE_URL isn't configured", async () => {
      delete process.env.INTAKE_LINK_BASE_URL;
      const { createIntakeLink } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      await expect(createIntakeLink(personId)).rejects.toThrow(/INTAKE_LINK_BASE_URL/);
    });
  });

  describe("handleIntakeLinkClick", () => {
    it("first click redirects to the Bask URL and arms a follow-up job due ~2 hours later", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const { url } = await createIntakeLink(personId);
      const rawToken = url.split("/go/")[1];

      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");

      const [token] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
      expect(token.clickedAt).not.toBeNull();

      const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(job).toBeDefined();
      expect(job.status).toBe("pending");
      expect(job.jobType).toBe("abandoned_intake_followup");
      const dueInMs = new Date(job.dueAt).getTime() - new Date(token.clickedAt!).getTime();
      expect(dueInMs).toBeGreaterThan(2 * 60 * 60 * 1000 - 5000);
      expect(dueInMs).toBeLessThan(2 * 60 * 60 * 1000 + 5000);
    });

    it("a second click on the same link redirects but does not arm a second follow-up job", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const { url } = await createIntakeLink(personId);
      const rawToken = url.split("/go/")[1];

      await handleIntakeLinkClick(rawToken);
      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");

      const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(jobs.length).toBe(1);
    });

    it("an unknown token still redirects, without creating a follow-up job", async () => {
      const { handleIntakeLinkClick } = await import("./intake-links.service.js");
      const { redirectUrl } = await handleIntakeLinkClick("this-token-does-not-exist");
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");
    });

    it("an expired token still redirects, without arming a follow-up job", async () => {
      const { handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const rawToken = "expired-test-token";
      await db.insert(intakeLinkTokensTable).values({
        personId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() - 1000),
      });

      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");

      const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(jobs.length).toBe(0);
    });
  });
});
