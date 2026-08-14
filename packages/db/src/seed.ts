/**
 * Bootstrap-admin seeding. Deliberately separate from migrate.ts: mixing
 * schema DDL with env-dependent data seeding is exactly the kind of
 * concern-mixing this rebuild avoids (see ARCHITECTURE.md).
 *
 * Reads BOOTSTRAP_ADMIN_EMAILS (comma-separated), inserts each as an
 * app_users row with role=admin, status=invited, and no password set — first
 * login goes through the normal invitation/password-set flow. Idempotent:
 * safe to run on every boot, after migrate.ts succeeds.
 */
import { db, pool, appUsersTable } from "./index.js";
import { sql } from "drizzle-orm";

const ADVISORY_LOCK_KEY = 4271_9001_338n;

function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    ),
  ];
}

async function seedBootstrapAdmins(): Promise<void> {
  const emails = parseAdminEmails(process.env.BOOTSTRAP_ADMIN_EMAILS);

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
    try {
      if (emails.length === 0) {
        // eslint-disable-next-line no-console
        console.warn("seed: BOOTSTRAP_ADMIN_EMAILS is unset or empty — no bootstrap admin users seeded");
        return;
      }
      for (const email of emails) {
        await db
          .insert(appUsersTable)
          .values({
            email,
            normalizedEmail: email,
            firstName: "",
            lastName: "",
            role: "admin",
            status: "invited",
            invitedAt: sql`now()`,
          })
          .onConflictDoNothing({ target: appUsersTable.normalizedEmail });
        // eslint-disable-next-line no-console
        console.log(`seed: bootstrap admin seeded or already present: ${email}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  seedBootstrapAdmins()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("seed: fatal error", err);
      process.exit(1);
    });
}

export { seedBootstrapAdmins, parseAdminEmails };
