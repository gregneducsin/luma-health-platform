import { z } from "zod";

export const metaPlatformSchema = z.enum(["instagram", "facebook_messenger"]);
export type MetaPlatform = z.infer<typeof metaPlatformSchema>;

export const metaChannelSchema = z.enum([
  "instagram",
  "facebook_messenger",
  "meta_comment",
]);
export type MetaChannel = z.infer<typeof metaChannelSchema>;

export const metaProspectLifecycleSchema = z.enum([
  "new",
  "engaged",
  "qualified",
  "converted",
  "closed",
]);
export type MetaProspectLifecycle = z.infer<typeof metaProspectLifecycleSchema>;

export const metaContactKindSchema = z.enum(["email", "phone"]);
export const metaContactStatusSchema = z.enum([
  "provided",
  "unverified",
  "verified",
]);
export type MetaContactKind = z.infer<typeof metaContactKindSchema>;
export type MetaContactStatus = z.infer<typeof metaContactStatusSchema>;

export const metaContactClaimSchema = z
  .object({
    id: z.string().uuid(),
    kind: metaContactKindSchema,
    normalizedValue: z.string().min(1).max(320),
    status: metaContactStatusSchema,
    source: z.enum(["inbound_message", "staff", "verification"]),
    providedAt: z.string().datetime({ offset: true }),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MetaContactClaimDto = z.infer<typeof metaContactClaimSchema>;

export const metaScopedIdentitySchema = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    platform: metaPlatformSchema,
    accountId: z.string().min(1).max(255),
    scopedSenderId: z.string().min(1).max(255),
    displayName: z.string().max(255).nullable(),
    username: z.string().max(255).nullable(),
    status: z.enum(["active", "blocked", "revoked"]),
  })
  .strict();
export type MetaScopedIdentityDto = z.infer<typeof metaScopedIdentitySchema>;

export const metaProspectSchema = z
  .object({
    id: z.string().uuid(),
    customerId: z.string().uuid().nullable(),
    firstName: z.string().max(255).nullable(),
    lastName: z.string().max(255).nullable(),
    lifecycleStatus: metaProspectLifecycleSchema,
    needsAttention: z.boolean(),
    needsAttentionReason: z.string().max(1000).nullable(),
    identities: z.array(metaScopedIdentitySchema),
    contactClaims: z.array(metaContactClaimSchema),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MetaProspectDto = z.infer<typeof metaProspectSchema>;

export const metaMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid().nullable(),
    channel: metaChannelSchema,
    direction: z.enum(["inbound", "outbound"]),
    messageKind: z.enum([
      "dm",
      "comment",
      "public_reply",
      "private_reply",
      "attachment",
      "system",
    ]),
    body: z.string().nullable(),
    externalMessageId: z.string().nullable(),
    externalCommentId: z.string().nullable(),
    parentExternalId: z.string().nullable(),
    mediaUrl: z.string().url().nullable(),
    sentBy: z.enum(["participant", "ai", "staff", "system"]).nullable(),
    deliveryStatus: z
      .enum([
        "received",
        "queued",
        "sent",
        "delivered",
        "read",
        "failed",
        "unknown",
      ])
      .nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MetaMessageDto = z.infer<typeof metaMessageSchema>;

export const metaConversationSchema = z
  .object({
    id: z.string().uuid(),
    prospect: metaProspectSchema,
    channel: metaPlatformSchema,
    externalThreadId: z.string().nullable(),
    status: z.enum(["active", "closed"]),
    owner: z.enum(["automation", "staff", "external"]),
    automationPaused: z.boolean(),
    needsAttention: z.boolean(),
    needsAttentionReason: z.string().max(1000).nullable(),
    lastInboundAt: z.string().datetime({ offset: true }).nullable(),
    messages: z.array(metaMessageSchema),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MetaConversationDto = z.infer<typeof metaConversationSchema>;

export const metaWebhookDeliverySchema = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    payloadDigest: z.string().min(32).max(128),
    signatureVerified: z.boolean(),
    status: z.enum(["received", "held", "normalized", "failed"]),
    safeErrorCode: z.string().max(100).nullable(),
    receivedAt: z.string().datetime({ offset: true }),
    processedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MetaWebhookDeliveryDto = z.infer<typeof metaWebhookDeliverySchema>;

export const metaWebhookEventSchema = z
  .object({
    id: z.string().uuid(),
    deliveryId: z.string().uuid(),
    connectionId: z.string().uuid(),
    logicalEventKey: z.string().min(1).max(512),
    eventType: z.string().min(1).max(100),
    externalObjectId: z.string().max(255).nullable(),
    status: z.enum(["held", "pending", "processed", "ignored", "failed"]),
    safeErrorCode: z.string().max(100).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    processedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MetaWebhookEventDto = z.infer<typeof metaWebhookEventSchema>;

export const metaAttributionSchema = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    prospectId: z.string().uuid().nullable(),
    sourceSurface: z.enum([
      "instagram_dm",
      "facebook_messenger",
      "instagram_comment",
      "facebook_comment",
      "unknown",
    ]),
    attributionState: z.enum([
      "provided",
      "not_ad",
      "unavailable_dynamic_ad",
      "unresolved",
    ]),
    campaignId: z.string().nullable(),
    adSetId: z.string().nullable(),
    adId: z.string().nullable(),
    postId: z.string().nullable(),
    commentId: z.string().nullable(),
    referralCode: z.string().nullable(),
    utmSource: z.string().nullable(),
    utmCampaign: z.string().nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MetaAttributionDto = z.infer<typeof metaAttributionSchema>;

export const metaIdentityVerificationSchema = z
  .object({
    id: z.string().uuid(),
    prospectId: z.string().uuid(),
    contactClaimId: z.string().uuid().nullable(),
    candidateCustomerId: z.string().uuid().nullable(),
    method: z.enum(["secure_link", "email_code", "sms_code", "two_factor"]),
    status: z.enum(["pending", "verified", "failed", "expired", "revoked"]),
    attemptCount: z.number().int().nonnegative(),
    expiresAt: z.string().datetime({ offset: true }),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MetaIdentityVerificationDto = z.infer<
  typeof metaIdentityVerificationSchema
>;

/**
 * Safe initial prospect input. Contact information and customer linkage are
 * deliberately absent: those are separate, audited operations.
 */
export const createMetaProspectSchema = z
  .object({
    connectionId: z.string().uuid(),
    platform: metaPlatformSchema,
    accountId: z.string().min(1).max(255),
    scopedSenderId: z.string().min(1).max(255),
    firstName: z.string().max(255).nullable().optional(),
    lastName: z.string().max(255).nullable().optional(),
    sourceSurface: z.enum(["instagram_dm", "facebook_messenger"]),
  })
  .strict();
export type CreateMetaProspect = z.infer<typeof createMetaProspectSchema>;
