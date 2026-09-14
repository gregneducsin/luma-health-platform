import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customersTable } from "./customers";

/**
 * An approved Meta business connection. Credentials are represented only by
 * encrypted-at-rest fields; this schema intentionally has no plaintext access
 * token column.
 */
export const metaConnectionsTable = pgTable(
  "meta_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    facebookPageId: text("facebook_page_id").notNull(),
    instagramAccountId: text("instagram_account_id"),
    displayName: text("display_name"),
    status: text("status", { enum: ["pending", "active", "paused", "revoked"] })
      .notNull()
      .default("pending"),
    tokenCiphertext: text("token_ciphertext"),
    tokenIv: text("token_iv"),
    tokenAuthTag: text("token_auth_tag"),
    tokenKeyVersion: text("token_key_version"),
    tokenFingerprint: text("token_fingerprint"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meta_connections_page_id_key").on(t.facebookPageId),
    uniqueIndex("meta_connections_ig_account_id_key").on(t.instagramAccountId),
    index("meta_connections_status_idx").on(t.status),
    check(
      "meta_connections_status_check",
      sql`${t.status} in ('pending', 'active', 'paused', 'revoked')`,
    ),
  ],
);

/**
 * A social sales lead. It can exist on scoped Meta identity alone and is not a
 * customer/patient record. customerId remains null until deterministic
 * existing-patient verification succeeds.
 */
export const metaProspectsTable = pgTable(
  "meta_prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").references(() => customersTable.id, {
      onDelete: "set null",
    }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    lifecycleStatus: text("lifecycle_status", {
      enum: ["new", "engaged", "qualified", "converted", "closed"],
    })
      .notNull()
      .default("new"),
    needsAttention: boolean("needs_attention").notNull().default(false),
    needsAttentionReason: text("needs_attention_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("meta_prospects_customer_id_idx").on(t.customerId),
    index("meta_prospects_lifecycle_status_idx").on(t.lifecycleStatus),
    index("meta_prospects_needs_attention_idx").on(t.needsAttention),
    check(
      "meta_prospects_lifecycle_status_check",
      sql`${t.lifecycleStatus} in ('new', 'engaged', 'qualified', 'converted', 'closed')`,
    ),
  ],
);

/** Account-scoped Meta identity. Mutable profile attributes are display-only. */
export const metaScopedIdentitiesTable = pgTable(
  "meta_scoped_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnectionsTable.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => metaProspectsTable.id, { onDelete: "cascade" }),
    platform: text("platform", {
      enum: ["instagram", "facebook_messenger"],
    }).notNull(),
    accountId: text("account_id").notNull(),
    scopedSenderId: text("scoped_sender_id").notNull(),
    displayName: text("display_name"),
    username: text("username"),
    profileUrl: text("profile_url"),
    status: text("status", { enum: ["active", "blocked", "revoked"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meta_scoped_identity_platform_account_sender_key").on(
      t.platform,
      t.accountId,
      t.scopedSenderId,
    ),
    index("meta_scoped_identities_connection_id_idx").on(t.connectionId),
    index("meta_scoped_identities_prospect_id_idx").on(t.prospectId),
    check(
      "meta_scoped_identities_platform_check",
      sql`${t.platform} in ('instagram', 'facebook_messenger')`,
    ),
    check(
      "meta_scoped_identities_status_check",
      sql`${t.status} in ('active', 'blocked', 'revoked')`,
    ),
  ],
);

/** Email or phone supplied during a social conversation; not identity proof. */
export const metaContactClaimsTable = pgTable(
  "meta_contact_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => metaProspectsTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["email", "phone"] }).notNull(),
    normalizedValue: text("normalized_value").notNull(),
    status: text("status", { enum: ["provided", "unverified", "verified"] })
      .notNull()
      .default("provided"),
    source: text("source", {
      enum: ["inbound_message", "staff", "verification"],
    }).notNull(),
    providedAt: timestamp("provided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meta_contact_claims_prospect_kind_value_key").on(
      t.prospectId,
      t.kind,
      t.normalizedValue,
    ),
    index("meta_contact_claims_prospect_status_idx").on(t.prospectId, t.status),
    check(
      "meta_contact_claims_kind_check",
      sql`${t.kind} in ('email', 'phone')`,
    ),
    check(
      "meta_contact_claims_status_check",
      sql`${t.status} in ('provided', 'unverified', 'verified')`,
    ),
    check(
      "meta_contact_claims_source_check",
      sql`${t.source} in ('inbound_message', 'staff', 'verification')`,
    ),
  ],
);

/** One signed HTTP delivery. Raw bytes are never stored in plaintext. */
export const metaWebhookDeliveriesTable = pgTable(
  "meta_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnectionsTable.id, { onDelete: "cascade" }),
    payloadDigest: text("payload_digest").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    status: text("status", {
      enum: ["received", "held", "normalized", "failed"],
    })
      .notNull()
      .default("received"),
    safeErrorCode: text("safe_error_code"),
    rawBodyCiphertext: text("raw_body_ciphertext"),
    rawBodyIv: text("raw_body_iv"),
    rawBodyAuthTag: text("raw_body_auth_tag"),
    rawBodyKeyVersion: text("raw_body_key_version"),
    rawBodyExpiresAt: timestamp("raw_body_expires_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("meta_webhook_deliveries_connection_digest_idx").on(
      t.connectionId,
      t.payloadDigest,
    ),
    index("meta_webhook_deliveries_status_received_idx").on(
      t.status,
      t.receivedAt,
    ),
    check(
      "meta_webhook_deliveries_status_check",
      sql`${t.status} in ('received', 'held', 'normalized', 'failed')`,
    ),
  ],
);

/** Canonical child event expanded from a signed Meta delivery. */
export const metaWebhookEventsTable = pgTable(
  "meta_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => metaWebhookDeliveriesTable.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnectionsTable.id, { onDelete: "cascade" }),
    logicalEventKey: text("logical_event_key").notNull(),
    eventType: text("event_type").notNull(),
    externalObjectId: text("external_object_id"),
    status: text("status", {
      enum: ["held", "pending", "processed", "ignored", "failed"],
    })
      .notNull()
      .default("held"),
    safeErrorCode: text("safe_error_code"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_webhook_events_connection_event_key").on(
      t.connectionId,
      t.logicalEventKey,
    ),
    index("meta_webhook_events_delivery_id_idx").on(t.deliveryId),
    index("meta_webhook_events_status_occurred_idx").on(t.status, t.occurredAt),
    check(
      "meta_webhook_events_status_check",
      sql`${t.status} in ('held', 'pending', 'processed', 'ignored', 'failed')`,
    ),
  ],
);

/** Native Meta thread, isolated from legacy SMS/email conversation storage. */
export const metaConversationsTable = pgTable(
  "meta_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnectionsTable.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => metaProspectsTable.id, { onDelete: "cascade" }),
    scopedIdentityId: uuid("scoped_identity_id")
      .notNull()
      .references(() => metaScopedIdentitiesTable.id, { onDelete: "cascade" }),
    channel: text("channel", {
      enum: ["instagram", "facebook_messenger"],
    }).notNull(),
    externalThreadId: text("external_thread_id"),
    status: text("status", { enum: ["active", "closed"] })
      .notNull()
      .default("active"),
    owner: text("owner", { enum: ["automation", "staff", "external"] })
      .notNull()
      .default("automation"),
    automationPaused: boolean("automation_paused").notNull().default(false),
    needsAttention: boolean("needs_attention").notNull().default(false),
    needsAttentionReason: text("needs_attention_reason"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meta_conversations_scoped_identity_key").on(
      t.scopedIdentityId,
    ),
    index("meta_conversations_prospect_id_idx").on(t.prospectId),
    index("meta_conversations_status_updated_idx").on(t.status, t.updatedAt),
    check(
      "meta_conversations_channel_check",
      sql`${t.channel} in ('instagram', 'facebook_messenger')`,
    ),
    check(
      "meta_conversations_status_check",
      sql`${t.status} in ('active', 'closed')`,
    ),
    check(
      "meta_conversations_owner_check",
      sql`${t.owner} in ('automation', 'staff', 'external')`,
    ),
  ],
);

/** Native DM/comment fact. Bodies remain in the isolated Meta domain. */
export const metaMessagesTable = pgTable(
  "meta_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnectionsTable.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(
      () => metaConversationsTable.id,
      { onDelete: "cascade" },
    ),
    webhookEventId: uuid("webhook_event_id").references(
      () => metaWebhookEventsTable.id,
      { onDelete: "set null" },
    ),
    channel: text("channel", {
      enum: ["instagram", "facebook_messenger", "meta_comment"],
    }).notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    messageKind: text("message_kind", {
      enum: [
        "dm",
        "comment",
        "public_reply",
        "private_reply",
        "attachment",
        "system",
      ],
    }).notNull(),
    body: text("body"),
    externalMessageId: text("external_message_id"),
    externalCommentId: text("external_comment_id"),
    parentExternalId: text("parent_external_id"),
    mediaUrl: text("media_url"),
    sentBy: text("sent_by", { enum: ["participant", "ai", "staff", "system"] }),
    deliveryStatus: text("delivery_status", {
      enum: [
        "received",
        "queued",
        "sent",
        "delivered",
        "read",
        "failed",
        "unknown",
      ],
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_messages_connection_message_id_key").on(
      t.connectionId,
      t.externalMessageId,
    ),
    uniqueIndex("meta_messages_connection_comment_id_key").on(
      t.connectionId,
      t.externalCommentId,
    ),
    index("meta_messages_conversation_time_idx").on(
      t.conversationId,
      t.occurredAt,
    ),
    index("meta_messages_webhook_event_id_idx").on(t.webhookEventId),
    check(
      "meta_messages_channel_check",
      sql`${t.channel} in ('instagram', 'facebook_messenger', 'meta_comment')`,
    ),
    check(
      "meta_messages_direction_check",
      sql`${t.direction} in ('inbound', 'outbound')`,
    ),
    check(
      "meta_messages_kind_check",
      sql`${t.messageKind} in ('dm', 'comment', 'public_reply', 'private_reply', 'attachment', 'system')`,
    ),
    check(
      "meta_messages_sent_by_check",
      sql`${t.sentBy} in ('participant', 'ai', 'staff', 'system')`,
    ),
    check(
      "meta_messages_delivery_status_check",
      sql`${t.deliveryStatus} in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown')`,
    ),
  ],
);

/** Campaign/ad/comment provenance. It is never an identity key. */
export const metaAttributionTable = pgTable(
  "meta_attribution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnectionsTable.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").references(() => metaProspectsTable.id, {
      onDelete: "set null",
    }),
    webhookEventId: uuid("webhook_event_id").references(
      () => metaWebhookEventsTable.id,
      { onDelete: "set null" },
    ),
    messageId: uuid("message_id").references(() => metaMessagesTable.id, {
      onDelete: "set null",
    }),
    sourceSurface: text("source_surface", {
      enum: [
        "instagram_dm",
        "facebook_messenger",
        "instagram_comment",
        "facebook_comment",
        "unknown",
      ],
    }).notNull(),
    attributionState: text("attribution_state", {
      enum: ["provided", "not_ad", "unavailable_dynamic_ad", "unresolved"],
    })
      .notNull()
      .default("unresolved"),
    campaignId: text("campaign_id"),
    adSetId: text("ad_set_id"),
    adId: text("ad_id"),
    postId: text("post_id"),
    commentId: text("comment_id"),
    referralCode: text("referral_code"),
    utmSource: text("utm_source"),
    utmCampaign: text("utm_campaign"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_attribution_webhook_event_key").on(t.webhookEventId),
    index("meta_attribution_prospect_time_idx").on(t.prospectId, t.occurredAt),
    index("meta_attribution_ad_id_idx").on(t.adId),
    check(
      "meta_attribution_source_surface_check",
      sql`${t.sourceSurface} in ('instagram_dm', 'facebook_messenger', 'instagram_comment', 'facebook_comment', 'unknown')`,
    ),
    check(
      "meta_attribution_state_check",
      sql`${t.attributionState} in ('provided', 'not_ad', 'unavailable_dynamic_ad', 'unresolved')`,
    ),
  ],
);

/** Deterministic proof attempt used only for existing-patient binding. */
export const metaIdentityVerificationsTable = pgTable(
  "meta_identity_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => metaProspectsTable.id, { onDelete: "cascade" }),
    contactClaimId: uuid("contact_claim_id").references(
      () => metaContactClaimsTable.id,
      { onDelete: "set null" },
    ),
    candidateCustomerId: uuid("candidate_customer_id").references(
      () => customersTable.id,
      { onDelete: "set null" },
    ),
    method: text("method", {
      enum: ["secure_link", "email_code", "sms_code", "two_factor"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "verified", "failed", "expired", "revoked"],
    })
      .notNull()
      .default("pending"),
    proofReferenceHash: text("proof_reference_hash"),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meta_identity_verifications_proof_hash_key").on(
      t.proofReferenceHash,
    ),
    index("meta_identity_verifications_prospect_status_idx").on(
      t.prospectId,
      t.status,
    ),
    index("meta_identity_verifications_candidate_idx").on(
      t.candidateCustomerId,
    ),
    check(
      "meta_identity_verifications_method_check",
      sql`${t.method} in ('secure_link', 'email_code', 'sms_code', 'two_factor')`,
    ),
    check(
      "meta_identity_verifications_status_check",
      sql`${t.status} in ('pending', 'verified', 'failed', 'expired', 'revoked')`,
    ),
  ],
);

/** Append-only record of bind, unbind, and rejected-binding decisions. */
export const metaIdentityBindingAuditsTable = pgTable(
  "meta_identity_binding_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => metaProspectsTable.id),
    scopedIdentityId: uuid("scoped_identity_id").references(
      () => metaScopedIdentitiesTable.id,
      { onDelete: "set null" },
    ),
    customerId: uuid("customer_id").references(() => customersTable.id, {
      onDelete: "set null",
    }),
    verificationId: uuid("verification_id").references(
      () => metaIdentityVerificationsTable.id,
      { onDelete: "set null" },
    ),
    action: text("action", {
      enum: ["bound", "unbound", "rejected"],
    }).notNull(),
    actorType: text("actor_type", {
      enum: ["system", "staff", "customer"],
    }).notNull(),
    actorEmail: text("actor_email"),
    reasonCode: text("reason_code").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("meta_binding_audits_prospect_time_idx").on(
      t.prospectId,
      t.occurredAt,
    ),
    index("meta_binding_audits_customer_id_idx").on(t.customerId),
    check(
      "meta_binding_audits_action_check",
      sql`${t.action} in ('bound', 'unbound', 'rejected')`,
    ),
    check(
      "meta_binding_audits_actor_type_check",
      sql`${t.actorType} in ('system', 'staff', 'customer')`,
    ),
  ],
);

export type MetaConnection = typeof metaConnectionsTable.$inferSelect;
export type MetaProspect = typeof metaProspectsTable.$inferSelect;
export type MetaScopedIdentity = typeof metaScopedIdentitiesTable.$inferSelect;
export type MetaContactClaim = typeof metaContactClaimsTable.$inferSelect;
export type MetaWebhookDelivery =
  typeof metaWebhookDeliveriesTable.$inferSelect;
export type MetaWebhookEvent = typeof metaWebhookEventsTable.$inferSelect;
export type MetaConversation = typeof metaConversationsTable.$inferSelect;
export type MetaMessage = typeof metaMessagesTable.$inferSelect;
export type MetaAttribution = typeof metaAttributionTable.$inferSelect;
export type MetaIdentityVerification =
  typeof metaIdentityVerificationsTable.$inferSelect;
export type MetaIdentityBindingAudit =
  typeof metaIdentityBindingAuditsTable.$inferSelect;
