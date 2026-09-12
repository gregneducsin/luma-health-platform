import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  metaAttributionTable,
  metaConnectionsTable,
  metaContactClaimsTable,
  metaConversationsTable,
  metaIdentityBindingAuditsTable,
  metaIdentityVerificationsTable,
  metaMessagesTable,
  metaProspectsTable,
  metaScopedIdentitiesTable,
  metaWebhookDeliveriesTable,
  metaWebhookEventsTable,
} from "./meta";

const TABLES = [
  metaConnectionsTable,
  metaProspectsTable,
  metaScopedIdentitiesTable,
  metaContactClaimsTable,
  metaConversationsTable,
  metaMessagesTable,
  metaWebhookDeliveriesTable,
  metaWebhookEventsTable,
  metaAttributionTable,
  metaIdentityVerificationsTable,
  metaIdentityBindingAuditsTable,
];

const EXPECTED_CHECKS = [
  "meta_connections_status_check",
  "meta_prospects_lifecycle_status_check",
  "meta_scoped_identities_platform_check",
  "meta_scoped_identities_status_check",
  "meta_contact_claims_kind_check",
  "meta_contact_claims_status_check",
  "meta_contact_claims_source_check",
  "meta_webhook_deliveries_status_check",
  "meta_webhook_events_status_check",
  "meta_conversations_channel_check",
  "meta_conversations_status_check",
  "meta_conversations_owner_check",
  "meta_messages_channel_check",
  "meta_messages_direction_check",
  "meta_messages_kind_check",
  "meta_messages_sent_by_check",
  "meta_messages_delivery_status_check",
  "meta_attribution_source_surface_check",
  "meta_attribution_state_check",
  "meta_identity_verifications_method_check",
  "meta_identity_verifications_status_check",
  "meta_binding_audits_action_check",
  "meta_binding_audits_actor_type_check",
].sort();

describe("Meta social schema", () => {
  it("uses only dedicated meta_* tables", () => {
    expect(TABLES.map(getTableName).sort()).toEqual(
      [
        "meta_attribution",
        "meta_connections",
        "meta_contact_claims",
        "meta_conversations",
        "meta_identity_binding_audits",
        "meta_identity_verifications",
        "meta_messages",
        "meta_prospects",
        "meta_scoped_identities",
        "meta_webhook_deliveries",
        "meta_webhook_events",
      ].sort(),
    );
    expect(
      TABLES.every((table) => getTableName(table).startsWith("meta_")),
    ).toBe(true);
  });

  it("defines database CHECK constraints for every finite Meta field", () => {
    const actual = TABLES.flatMap((table) =>
      getTableConfig(table).checks.map((constraint) => constraint.name),
    ).sort();

    expect(actual).toEqual(EXPECTED_CHECKS);
  });

  it("permits a Meta prospect without customer or contact data", () => {
    const columns = getTableColumns(metaProspectsTable);

    expect(columns.customerId.notNull).toBe(false);
    expect(columns.firstName.notNull).toBe(false);
    expect(columns.lastName.notNull).toBe(false);
    expect("email" in columns).toBe(false);
    expect("phone" in columns).toBe(false);
  });

  it("keeps supplied contact claims separate from verified identity", () => {
    const columns = getTableColumns(metaContactClaimsTable);

    expect(columns.prospectId.notNull).toBe(true);
    expect(columns.kind.enumValues).toEqual(["email", "phone"]);
    expect(columns.status.enumValues).toEqual([
      "provided",
      "unverified",
      "verified",
    ]);
    expect(columns.status.default).toBe("provided");
    expect("customerId" in columns).toBe(false);
  });

  it("scopes Meta identities by platform, account, and sender", () => {
    const config = getTableConfig(metaScopedIdentitiesTable);
    const scopedIndex = config.indexes.find(
      (item) =>
        item.config.name === "meta_scoped_identity_platform_account_sender_key",
    );

    expect(scopedIndex?.config.unique).toBe(true);
    expect(
      scopedIndex?.config.columns.map(
        (column) => (column as { name?: string }).name,
      ),
    ).toEqual(["platform", "account_id", "scoped_sender_id"]);
  });

  it("models deterministic verification and append-only binding audit separately", () => {
    const verification = getTableColumns(metaIdentityVerificationsTable);
    const audit = getTableColumns(metaIdentityBindingAuditsTable);

    expect(verification.candidateCustomerId.notNull).toBe(false);
    expect(verification.status.enumValues).toEqual([
      "pending",
      "verified",
      "failed",
      "expired",
      "revoked",
    ]);
    expect(audit.action.enumValues).toEqual(["bound", "unbound", "rejected"]);
    expect(audit.verificationId.notNull).toBe(false);

    const auditConfig = getTableConfig(metaIdentityBindingAuditsTable);
    const prospectForeignKey = auditConfig.foreignKeys.find((foreignKey) =>
      foreignKey
        .reference()
        .columns.some((column) => column.name === "prospect_id"),
    );
    expect(prospectForeignKey?.onDelete).not.toBe("cascade");
  });

  it("has no plaintext token or raw-payload column", () => {
    const connectionColumns = Object.values(
      getTableColumns(metaConnectionsTable),
    ).map((column) => column.name);
    const deliveryColumns = Object.values(
      getTableColumns(metaWebhookDeliveriesTable),
    ).map((column) => column.name);

    expect(connectionColumns).not.toContain("access_token");
    expect(connectionColumns).not.toContain("token");
    expect(connectionColumns).toEqual(
      expect.arrayContaining([
        "token_ciphertext",
        "token_iv",
        "token_auth_tag",
        "token_key_version",
      ]),
    );
    expect(deliveryColumns).not.toContain("raw_payload");
    expect(deliveryColumns).not.toContain("raw_body");
    expect(deliveryColumns).toEqual(
      expect.arrayContaining([
        "payload_digest",
        "raw_body_ciphertext",
        "raw_body_iv",
        "raw_body_auth_tag",
      ]),
    );
  });

  it("deduplicates canonical child events independently from deliveries", () => {
    const config = getTableConfig(metaWebhookEventsTable);
    const eventIndex = config.indexes.find(
      (item) => item.config.name === "meta_webhook_events_connection_event_key",
    );

    expect(eventIndex?.config.unique).toBe(true);
    expect(
      eventIndex?.config.columns.map(
        (column) => (column as { name?: string }).name,
      ),
    ).toEqual(["connection_id", "logical_event_key"]);
  });
});
