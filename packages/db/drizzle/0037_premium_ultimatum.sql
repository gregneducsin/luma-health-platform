CREATE TABLE "meta_attribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"prospect_id" uuid,
	"webhook_event_id" uuid,
	"message_id" uuid,
	"source_surface" text NOT NULL,
	"attribution_state" text DEFAULT 'unresolved' NOT NULL,
	"campaign_id" text,
	"ad_set_id" text,
	"ad_id" text,
	"post_id" text,
	"comment_id" text,
	"referral_code" text,
	"utm_source" text,
	"utm_campaign" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_attribution_source_surface_check" CHECK ("meta_attribution"."source_surface" in ('instagram_dm', 'facebook_messenger', 'instagram_comment', 'facebook_comment', 'unknown')),
	CONSTRAINT "meta_attribution_state_check" CHECK ("meta_attribution"."attribution_state" in ('provided', 'not_ad', 'unavailable_dynamic_ad', 'unresolved'))
);
--> statement-breakpoint
CREATE TABLE "meta_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facebook_page_id" text NOT NULL,
	"instagram_account_id" text,
	"display_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_ciphertext" text,
	"token_iv" text,
	"token_auth_tag" text,
	"token_key_version" text,
	"token_fingerprint" text,
	"token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_connections_status_check" CHECK ("meta_connections"."status" in ('pending', 'active', 'paused', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "meta_contact_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"normalized_value" text NOT NULL,
	"status" text DEFAULT 'provided' NOT NULL,
	"source" text NOT NULL,
	"provided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_contact_claims_kind_check" CHECK ("meta_contact_claims"."kind" in ('email', 'phone')),
	CONSTRAINT "meta_contact_claims_status_check" CHECK ("meta_contact_claims"."status" in ('provided', 'unverified', 'verified')),
	CONSTRAINT "meta_contact_claims_source_check" CHECK ("meta_contact_claims"."source" in ('inbound_message', 'staff', 'verification'))
);
--> statement-breakpoint
CREATE TABLE "meta_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"scoped_identity_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_thread_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"owner" text DEFAULT 'automation' NOT NULL,
	"automation_paused" boolean DEFAULT false NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"needs_attention_reason" text,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_conversations_channel_check" CHECK ("meta_conversations"."channel" in ('instagram', 'facebook_messenger')),
	CONSTRAINT "meta_conversations_status_check" CHECK ("meta_conversations"."status" in ('active', 'closed')),
	CONSTRAINT "meta_conversations_owner_check" CHECK ("meta_conversations"."owner" in ('automation', 'staff', 'external'))
);
--> statement-breakpoint
CREATE TABLE "meta_identity_binding_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"scoped_identity_id" uuid,
	"customer_id" uuid,
	"verification_id" uuid,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_email" text,
	"reason_code" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_binding_audits_action_check" CHECK ("meta_identity_binding_audits"."action" in ('bound', 'unbound', 'rejected')),
	CONSTRAINT "meta_binding_audits_actor_type_check" CHECK ("meta_identity_binding_audits"."actor_type" in ('system', 'staff', 'customer'))
);
--> statement-breakpoint
CREATE TABLE "meta_identity_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"contact_claim_id" uuid,
	"candidate_customer_id" uuid,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proof_reference_hash" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_identity_verifications_method_check" CHECK ("meta_identity_verifications"."method" in ('secure_link', 'email_code', 'sms_code', 'two_factor')),
	CONSTRAINT "meta_identity_verifications_status_check" CHECK ("meta_identity_verifications"."status" in ('pending', 'verified', 'failed', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "meta_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"conversation_id" uuid,
	"webhook_event_id" uuid,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"message_kind" text NOT NULL,
	"body" text,
	"external_message_id" text,
	"external_comment_id" text,
	"parent_external_id" text,
	"media_url" text,
	"sent_by" text,
	"delivery_status" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_messages_channel_check" CHECK ("meta_messages"."channel" in ('instagram', 'facebook_messenger', 'meta_comment')),
	CONSTRAINT "meta_messages_direction_check" CHECK ("meta_messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "meta_messages_kind_check" CHECK ("meta_messages"."message_kind" in ('dm', 'comment', 'public_reply', 'private_reply', 'attachment', 'system')),
	CONSTRAINT "meta_messages_sent_by_check" CHECK ("meta_messages"."sent_by" in ('participant', 'ai', 'staff', 'system')),
	CONSTRAINT "meta_messages_delivery_status_check" CHECK ("meta_messages"."delivery_status" in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "meta_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"first_name" text,
	"last_name" text,
	"lifecycle_status" text DEFAULT 'new' NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"needs_attention_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_prospects_lifecycle_status_check" CHECK ("meta_prospects"."lifecycle_status" in ('new', 'engaged', 'qualified', 'converted', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "meta_scoped_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"account_id" text NOT NULL,
	"scoped_sender_id" text NOT NULL,
	"display_name" text,
	"username" text,
	"profile_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_scoped_identities_platform_check" CHECK ("meta_scoped_identities"."platform" in ('instagram', 'facebook_messenger')),
	CONSTRAINT "meta_scoped_identities_status_check" CHECK ("meta_scoped_identities"."status" in ('active', 'blocked', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "meta_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"payload_digest" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"safe_error_code" text,
	"raw_body_ciphertext" text,
	"raw_body_iv" text,
	"raw_body_auth_tag" text,
	"raw_body_key_version" text,
	"raw_body_expires_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "meta_webhook_deliveries_status_check" CHECK ("meta_webhook_deliveries"."status" in ('received', 'held', 'normalized', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "meta_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"logical_event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"external_object_id" text,
	"status" text DEFAULT 'held' NOT NULL,
	"safe_error_code" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_webhook_events_status_check" CHECK ("meta_webhook_events"."status" in ('held', 'pending', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "meta_attribution" ADD CONSTRAINT "meta_attribution_connection_id_meta_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_attribution" ADD CONSTRAINT "meta_attribution_prospect_id_meta_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "meta_prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_attribution" ADD CONSTRAINT "meta_attribution_webhook_event_id_meta_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "meta_webhook_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_attribution" ADD CONSTRAINT "meta_attribution_message_id_meta_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "meta_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_contact_claims" ADD CONSTRAINT "meta_contact_claims_prospect_id_meta_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "meta_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_connection_id_meta_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_prospect_id_meta_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "meta_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_scoped_identity_id_meta_scoped_identities_id_fk" FOREIGN KEY ("scoped_identity_id") REFERENCES "meta_scoped_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_binding_audits" ADD CONSTRAINT "meta_identity_binding_audits_prospect_id_meta_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "meta_prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_binding_audits" ADD CONSTRAINT "meta_identity_binding_audits_scoped_identity_id_meta_scoped_identities_id_fk" FOREIGN KEY ("scoped_identity_id") REFERENCES "meta_scoped_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_binding_audits" ADD CONSTRAINT "meta_identity_binding_audits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_binding_audits" ADD CONSTRAINT "meta_identity_binding_audits_verification_id_meta_identity_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "meta_identity_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_verifications" ADD CONSTRAINT "meta_identity_verifications_prospect_id_meta_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "meta_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_verifications" ADD CONSTRAINT "meta_identity_verifications_contact_claim_id_meta_contact_claims_id_fk" FOREIGN KEY ("contact_claim_id") REFERENCES "meta_contact_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_identity_verifications" ADD CONSTRAINT "meta_identity_verifications_candidate_customer_id_customers_id_fk" FOREIGN KEY ("candidate_customer_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_messages" ADD CONSTRAINT "meta_messages_connection_id_meta_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_messages" ADD CONSTRAINT "meta_messages_conversation_id_meta_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "meta_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_messages" ADD CONSTRAINT "meta_messages_webhook_event_id_meta_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "meta_webhook_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_prospects" ADD CONSTRAINT "meta_prospects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_scoped_identities" ADD CONSTRAINT "meta_scoped_identities_connection_id_meta_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_scoped_identities" ADD CONSTRAINT "meta_scoped_identities_prospect_id_meta_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "meta_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_webhook_deliveries" ADD CONSTRAINT "meta_webhook_deliveries_connection_id_meta_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_webhook_events" ADD CONSTRAINT "meta_webhook_events_delivery_id_meta_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "meta_webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_webhook_events" ADD CONSTRAINT "meta_webhook_events_connection_id_meta_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_attribution_webhook_event_key" ON "meta_attribution" USING btree ("webhook_event_id");--> statement-breakpoint
CREATE INDEX "meta_attribution_prospect_time_idx" ON "meta_attribution" USING btree ("prospect_id","occurred_at");--> statement-breakpoint
CREATE INDEX "meta_attribution_ad_id_idx" ON "meta_attribution" USING btree ("ad_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_connections_page_id_key" ON "meta_connections" USING btree ("facebook_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_connections_ig_account_id_key" ON "meta_connections" USING btree ("instagram_account_id");--> statement-breakpoint
CREATE INDEX "meta_connections_status_idx" ON "meta_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_contact_claims_prospect_kind_value_key" ON "meta_contact_claims" USING btree ("prospect_id","kind","normalized_value");--> statement-breakpoint
CREATE INDEX "meta_contact_claims_prospect_status_idx" ON "meta_contact_claims" USING btree ("prospect_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversations_scoped_identity_key" ON "meta_conversations" USING btree ("scoped_identity_id");--> statement-breakpoint
CREATE INDEX "meta_conversations_prospect_id_idx" ON "meta_conversations" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "meta_conversations_status_updated_idx" ON "meta_conversations" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "meta_binding_audits_prospect_time_idx" ON "meta_identity_binding_audits" USING btree ("prospect_id","occurred_at");--> statement-breakpoint
CREATE INDEX "meta_binding_audits_customer_id_idx" ON "meta_identity_binding_audits" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_identity_verifications_proof_hash_key" ON "meta_identity_verifications" USING btree ("proof_reference_hash");--> statement-breakpoint
CREATE INDEX "meta_identity_verifications_prospect_status_idx" ON "meta_identity_verifications" USING btree ("prospect_id","status");--> statement-breakpoint
CREATE INDEX "meta_identity_verifications_candidate_idx" ON "meta_identity_verifications" USING btree ("candidate_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_messages_connection_message_id_key" ON "meta_messages" USING btree ("connection_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_messages_connection_comment_id_key" ON "meta_messages" USING btree ("connection_id","external_comment_id");--> statement-breakpoint
CREATE INDEX "meta_messages_conversation_time_idx" ON "meta_messages" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "meta_messages_webhook_event_id_idx" ON "meta_messages" USING btree ("webhook_event_id");--> statement-breakpoint
CREATE INDEX "meta_prospects_customer_id_idx" ON "meta_prospects" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "meta_prospects_lifecycle_status_idx" ON "meta_prospects" USING btree ("lifecycle_status");--> statement-breakpoint
CREATE INDEX "meta_prospects_needs_attention_idx" ON "meta_prospects" USING btree ("needs_attention");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_scoped_identity_platform_account_sender_key" ON "meta_scoped_identities" USING btree ("platform","account_id","scoped_sender_id");--> statement-breakpoint
CREATE INDEX "meta_scoped_identities_connection_id_idx" ON "meta_scoped_identities" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "meta_scoped_identities_prospect_id_idx" ON "meta_scoped_identities" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "meta_webhook_deliveries_connection_digest_idx" ON "meta_webhook_deliveries" USING btree ("connection_id","payload_digest");--> statement-breakpoint
CREATE INDEX "meta_webhook_deliveries_status_received_idx" ON "meta_webhook_deliveries" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_webhook_events_connection_event_key" ON "meta_webhook_events" USING btree ("connection_id","logical_event_key");--> statement-breakpoint
CREATE INDEX "meta_webhook_events_delivery_id_idx" ON "meta_webhook_events" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "meta_webhook_events_status_occurred_idx" ON "meta_webhook_events" USING btree ("status","occurred_at");