import { describe, expect, it } from "vitest";
import {
  createMetaProspectSchema,
  metaContactClaimSchema,
  metaMessageSchema,
  metaProspectSchema,
  metaWebhookDeliverySchema,
} from "./meta-conversations";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-12T03:00:00.000Z";

describe("Meta conversation contracts", () => {
  it("accepts a scoped Meta prospect without name, email, phone, or customer", () => {
    expect(
      createMetaProspectSchema.parse({
        connectionId: UUID_A,
        platform: "instagram",
        accountId: "ig-business-1",
        scopedSenderId: "igsid-1",
        sourceSurface: "instagram_dm",
      }),
    ).toEqual({
      connectionId: UUID_A,
      platform: "instagram",
      accountId: "ig-business-1",
      scopedSenderId: "igsid-1",
      sourceSurface: "instagram_dm",
    });
  });

  it("does not permit customer linkage or contact claims in prospect creation", () => {
    const base = {
      connectionId: UUID_A,
      platform: "facebook_messenger",
      accountId: "page-1",
      scopedSenderId: "psid-1",
      sourceSurface: "facebook_messenger",
    } as const;

    expect(
      createMetaProspectSchema.safeParse({ ...base, customerId: UUID_B })
        .success,
    ).toBe(false);
    expect(
      createMetaProspectSchema.safeParse({
        ...base,
        email: "person@example.com",
      }).success,
    ).toBe(false);
    expect(
      createMetaProspectSchema.safeParse({ ...base, phone: "+15555550123" })
        .success,
    ).toBe(false);
  });

  it("does not create a prospect from comment-only activity", () => {
    expect(
      createMetaProspectSchema.safeParse({
        connectionId: UUID_A,
        platform: "instagram",
        accountId: "ig-business-1",
        scopedSenderId: "igsid-1",
        sourceSurface: "instagram_comment",
      }).success,
    ).toBe(false);
  });

  it.each(["provided", "unverified", "verified"] as const)(
    "supports the explicit %s contact state",
    (status) => {
      expect(
        metaContactClaimSchema.safeParse({
          id: UUID_A,
          kind: "email",
          normalizedValue: "person@example.com",
          status,
          source: "inbound_message",
          providedAt: NOW,
          verifiedAt: status === "verified" ? NOW : null,
        }).success,
      ).toBe(true);
    },
  );

  it("keeps an unlinked prospect safe and explicit", () => {
    expect(
      metaProspectSchema.parse({
        id: UUID_A,
        customerId: null,
        firstName: null,
        lastName: null,
        lifecycleStatus: "new",
        needsAttention: false,
        needsAttentionReason: null,
        identities: [
          {
            id: UUID_B,
            connectionId: UUID_C,
            platform: "instagram",
            accountId: "ig-business-1",
            scopedSenderId: "igsid-1",
            displayName: null,
            username: null,
            status: "active",
          },
        ],
        contactClaims: [],
        createdAt: NOW,
        updatedAt: NOW,
      }).customerId,
    ).toBeNull();
  });

  it("keeps comments inside the Meta message contract", () => {
    expect(
      metaMessageSchema.safeParse({
        id: UUID_A,
        conversationId: null,
        channel: "meta_comment",
        direction: "inbound",
        messageKind: "comment",
        body: "How can I learn more?",
        externalMessageId: null,
        externalCommentId: "comment-1",
        parentExternalId: "post-1",
        mediaUrl: null,
        sentBy: "participant",
        deliveryStatus: "received",
        occurredAt: NOW,
      }).success,
    ).toBe(true);
  });

  it("exposes only redacted webhook delivery metadata", () => {
    const safe = {
      id: UUID_A,
      connectionId: UUID_B,
      payloadDigest: "a".repeat(64),
      signatureVerified: true,
      status: "held",
      safeErrorCode: null,
      receivedAt: NOW,
      processedAt: null,
    } as const;

    expect(metaWebhookDeliverySchema.safeParse(safe).success).toBe(true);
    expect(
      metaWebhookDeliverySchema.safeParse({ ...safe, rawBody: "secret" })
        .success,
    ).toBe(false);
    expect(
      metaWebhookDeliverySchema.safeParse({ ...safe, accessToken: "secret" })
        .success,
    ).toBe(false);
  });
});
