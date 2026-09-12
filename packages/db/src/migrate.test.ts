/**
 * Migration smoke test: fresh isolated schema -> run migrations -> assert
 * every expected table exists. This is the single highest-value test for
 * this package, since a broken migration is the prototype's most common
 * historical failure mode (see ARCHITECTURE.md).
 */
import crypto from "crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCHEMA_PATTERN = /^_luma_test_[0-9]+_[a-f0-9]+$/;

const EXPECTED_TABLES = [
  "__drizzle_migrations",
  "app_users",
  "user_sessions",
  "user_invitation_tokens",
  "password_reset_tokens",
  "user_audit_events",
  "customers",
  "external_identities",
  "purchases",
  "purchase_classification_audits",
  "webhook_events",
  "questionnaire_events",
  "failed_payment_events",
  "employees",
  "payroll_weeks",
  "employee_weekly_hours",
  "employee_bonuses",
  "payroll_audit_events",
  "marketing_spend_weeks",
  "intake_link_tokens",
  "follow_up_jobs",
  "conversations",
  "conversation_messages",
  "abandoned_cart_triggers",
  "consumer_affairs_triggers",
  "support_conversations",
  "support_conversation_messages",
  "review_request_triggers",
  "lead_checkin_triggers",
  "email_conversations",
  "email_conversation_messages",
  "support_email_conversations",
  "support_email_conversation_messages",
  "abandoned_cart_email_triggers",
  "meta_lead_email_triggers",
  "unmatched_email_threads",
  "unmatched_email_messages",
  "objection_reengagement_triggers",
  "unmatched_sms_threads",
  "unmatched_sms_messages",
  "customer_notes",
  "meta_connections",
  "meta_prospects",
  "meta_scoped_identities",
  "meta_contact_claims",
  "meta_conversations",
  "meta_messages",
  "meta_webhook_deliveries",
  "meta_webhook_events",
  "meta_attribution",
  "meta_identity_verifications",
  "meta_identity_binding_audits",
].sort();

let testSchema: string;
let adminClient: Client;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run db tests.");
  }

  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  testSchema = `_luma_test_${ts}_${rand}`;
  if (!SCHEMA_PATTERN.test(testSchema)) {
    throw new Error(`Generated schema name failed validation: ${testSchema}`);
  }

  adminClient = new Client({ connectionString: process.env.DATABASE_URL });
  await adminClient.connect();
  await adminClient.query(`CREATE SCHEMA "${testSchema}"`);

  process.env.NODE_ENV = "test";
  process.env.POSTGRES_SCHEMA = testSchema;

  // Dynamic import so ./index.js reads POSTGRES_SCHEMA *after* it's set above
  // (the pool's search_path is fixed at module-load time).
  const { runMigrations } = await import("./migrate.js");
  await runMigrations();
}, 30_000);

afterAll(async () => {
  if (testSchema && SCHEMA_PATTERN.test(testSchema)) {
    await adminClient.query(`DROP SCHEMA "${testSchema}" CASCADE`);
  }
  await adminClient.end();
  const { pool } = await import("./index.js");
  await pool.end();
});

describe("migrate", () => {
  it("creates every expected table in the isolated schema", async () => {
    const result = await adminClient.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [testSchema],
    );
    const actual = result.rows.map((r) => r.table_name).sort();
    expect(actual).toEqual(EXPECTED_TABLES);
  });

  it("creates the person_number and employee_number sequences", async () => {
    const result = await adminClient.query<{ sequence_name: string }>(
      `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`,
      [testSchema],
    );
    const names = result.rows.map((r) => r.sequence_name);
    // Plus drizzle's own tracking-table sequence and serial-column-implied
    // sequences (purchases.id, employee_weekly_hours doesn't use serial —
    // only purchases does) — assert the two we care about are present rather
    // than asserting the exact full set, which would break every time a new
    // serial column is added.
    expect(names).toContain("person_number_seq");
    expect(names).toContain("employee_number_seq");
  });

  it("supports a contactless Meta prospect and enforces account-scoped identity uniqueness", async () => {
    const connection = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_connections (facebook_page_id) VALUES ($1) RETURNING id`,
      ["test-page-1"],
    );
    const prospect = await adminClient.query<{
      id: string;
      customer_id: string | null;
    }>(
      `INSERT INTO "${testSchema}".meta_prospects DEFAULT VALUES RETURNING id, customer_id`,
    );

    expect(prospect.rows[0]?.customer_id).toBeNull();

    const identityValues = [
      connection.rows[0]?.id,
      prospect.rows[0]?.id,
      "instagram",
      "test-account-1",
      "test-sender-1",
    ];
    await adminClient.query(
      `INSERT INTO "${testSchema}".meta_scoped_identities
         (connection_id, prospect_id, platform, account_id, scoped_sender_id)
       VALUES ($1, $2, $3, $4, $5)`,
      identityValues,
    );
    await expect(
      adminClient.query(
        `INSERT INTO "${testSchema}".meta_scoped_identities
           (connection_id, prospect_id, platform, account_id, scoped_sender_id)
         VALUES ($1, $2, $3, $4, $5)`,
        identityValues,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects invalid finite Meta state and policy values at the database boundary", async () => {
    const connection = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_connections (facebook_page_id) VALUES ($1) RETURNING id`,
      ["constraint-test-page"],
    );
    const prospect = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_prospects DEFAULT VALUES RETURNING id`,
    );
    const identity = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_scoped_identities
         (connection_id, prospect_id, platform, account_id, scoped_sender_id)
       VALUES ($1, $2, 'instagram', 'constraint-test-account', 'constraint-test-sender')
       RETURNING id`,
      [connection.rows[0]?.id, prospect.rows[0]?.id],
    );
    const contactClaim = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_contact_claims
         (prospect_id, kind, normalized_value, source)
       VALUES ($1, 'email', 'constraint@example.com', 'inbound_message')
       RETURNING id`,
      [prospect.rows[0]?.id],
    );
    const delivery = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_webhook_deliveries
         (connection_id, payload_digest, signature_verified)
       VALUES ($1, $2, true)
       RETURNING id`,
      [connection.rows[0]?.id, "b".repeat(64)],
    );
    const event = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_webhook_events
         (delivery_id, connection_id, logical_event_key, event_type, occurred_at)
       VALUES ($1, $2, 'constraint-event', 'message', now())
       RETURNING id`,
      [delivery.rows[0]?.id, connection.rows[0]?.id],
    );
    const conversation = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_conversations
         (connection_id, prospect_id, scoped_identity_id, channel)
       VALUES ($1, $2, $3, 'instagram')
       RETURNING id`,
      [connection.rows[0]?.id, prospect.rows[0]?.id, identity.rows[0]?.id],
    );
    const message = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_messages
         (connection_id, conversation_id, webhook_event_id, channel, direction, message_kind, occurred_at)
       VALUES ($1, $2, $3, 'instagram', 'inbound', 'dm', now())
       RETURNING id`,
      [connection.rows[0]?.id, conversation.rows[0]?.id, event.rows[0]?.id],
    );
    const attribution = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_attribution
         (connection_id, prospect_id, webhook_event_id, message_id, source_surface, occurred_at)
       VALUES ($1, $2, $3, $4, 'instagram_dm', now())
       RETURNING id`,
      [
        connection.rows[0]?.id,
        prospect.rows[0]?.id,
        event.rows[0]?.id,
        message.rows[0]?.id,
      ],
    );
    const verification = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_identity_verifications
         (prospect_id, contact_claim_id, method, expires_at)
       VALUES ($1, $2, 'email_code', now() + interval '15 minutes')
       RETURNING id`,
      [prospect.rows[0]?.id, contactClaim.rows[0]?.id],
    );
    const bindingAudit = await adminClient.query<{ id: string }>(
      `INSERT INTO "${testSchema}".meta_identity_binding_audits
         (prospect_id, scoped_identity_id, verification_id, action, actor_type, reason_code)
       VALUES ($1, $2, $3, 'bound', 'system', 'constraint_test')
       RETURNING id`,
      [prospect.rows[0]?.id, identity.rows[0]?.id, verification.rows[0]?.id],
    );

    const invalidUpdates = [
      ["meta_connections", "status", connection.rows[0]?.id],
      ["meta_prospects", "lifecycle_status", prospect.rows[0]?.id],
      ["meta_scoped_identities", "platform", identity.rows[0]?.id],
      ["meta_scoped_identities", "status", identity.rows[0]?.id],
      ["meta_contact_claims", "kind", contactClaim.rows[0]?.id],
      ["meta_contact_claims", "status", contactClaim.rows[0]?.id],
      ["meta_contact_claims", "source", contactClaim.rows[0]?.id],
      ["meta_webhook_deliveries", "status", delivery.rows[0]?.id],
      ["meta_webhook_events", "status", event.rows[0]?.id],
      ["meta_conversations", "channel", conversation.rows[0]?.id],
      ["meta_conversations", "status", conversation.rows[0]?.id],
      ["meta_conversations", "owner", conversation.rows[0]?.id],
      ["meta_messages", "channel", message.rows[0]?.id],
      ["meta_messages", "direction", message.rows[0]?.id],
      ["meta_messages", "message_kind", message.rows[0]?.id],
      ["meta_messages", "sent_by", message.rows[0]?.id],
      ["meta_messages", "delivery_status", message.rows[0]?.id],
      ["meta_attribution", "source_surface", attribution.rows[0]?.id],
      ["meta_attribution", "attribution_state", attribution.rows[0]?.id],
      ["meta_identity_verifications", "method", verification.rows[0]?.id],
      ["meta_identity_verifications", "status", verification.rows[0]?.id],
      ["meta_identity_binding_audits", "action", bindingAudit.rows[0]?.id],
      ["meta_identity_binding_audits", "actor_type", bindingAudit.rows[0]?.id],
    ] as const;

    for (const [table, column, id] of invalidUpdates) {
      await expect(
        adminClient.query(
          `UPDATE "${testSchema}"."${table}" SET "${column}" = $1 WHERE id = $2`,
          ["not_a_valid_value", id],
        ),
        `${table}.${column} must be database-enforced`,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("preserves required legacy customer identity columns", async () => {
    const result = await adminClient.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'customers'
          AND column_name IN ('first_name', 'last_name', 'email')
        ORDER BY column_name`,
      [testSchema],
    );

    expect(result.rows).toEqual([
      { column_name: "email", is_nullable: "NO" },
      { column_name: "first_name", is_nullable: "NO" },
      { column_name: "last_name", is_nullable: "NO" },
    ]);
  });

  it("is idempotent — running twice is a safe no-op", async () => {
    const { runMigrations } = await import("./migrate.js");
    await expect(runMigrations()).resolves.not.toThrow();
  });
});
