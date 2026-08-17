/**
 * Lucy knowledge source — unit tests.
 *
 * LK-01  verifyLucySourceIntegrity() returns ok: true
 * LK-02  LF-normalised content hash matches recorded hash (hashesMatch)
 * LK-03  Byte count matches recorded value
 * LK-04  Line count matches recorded value (444)
 * LK-05  Section count matches recorded value (17)
 * LK-06  No omitted sections
 * LK-07  No added sections
 * LK-08  All 17 expected sections are present by name
 * LK-09  Semaglutide pricing values match the Lucy document exactly
 * LK-10  Tirzepatide pricing values match the Lucy document exactly
 * LK-11  Tirzepatide dose progression string matches the Lucy document
 * LK-12  Semaglutide dose progression string matches the Lucy document
 * LK-13  Approved comparison language (tirzepatide > semaglutide) is in the catalog
 * LK-14  "provider_chooses_medication" is in product_comparison prohibited claims
 * LK-15  All Lucy-v1 topics have legalStatus "approved"
 * LK-16  Metadata has correct version, status, source, approvedBy
 * LK-17  getPreviewEnabledTopics() includes all Lucy-v1 topic keys
 * LK-18  Medical boundary topics exist in the catalog (no-escalate & escalate entries)
 * LK-19  No invented prices in semaglutide_pricing approvedText
 * LK-20  No invented prices in tirzepatide_pricing approvedText
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { LUCY_KNOWLEDGE_CONTENT, LUCY_KNOWLEDGE_META, LUCY_KNOWLEDGE_EXPECTED_SECTIONS, verifyLucySourceIntegrity } from "./lucy-knowledge-source.js";
import { KNOWLEDGE_CATALOG, getPreviewEnabledTopics, getTopicByKey, LUCY_V1_TOPIC_KEYS } from "./knowledge-catalog.js";

// ── LK-01..LK-08: Source integrity ───────────────────────────────────────────

describe("LK-01: verifyLucySourceIntegrity() returns ok", () => {
  it("full integrity check passes with no discrepancies", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.ok).toBe(true);
  });
});

describe("LK-02: LF-normalised content hash matches recorded hash", () => {
  it("SHA-256 of stored content equals LUCY_KNOWLEDGE_META.contentHash", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.hashesMatch).toBe(true);
    expect(report.storedHash).toBe(LUCY_KNOWLEDGE_META.contentHash);
  });

  it("recorded hash is distinct from the original CRLF file hash", () => {
    expect(LUCY_KNOWLEDGE_META.contentHash).not.toBe(LUCY_KNOWLEDGE_META.originalFileHash);
  });

  it("sha256 can be independently verified", () => {
    const computed = createHash("sha256").update(LUCY_KNOWLEDGE_CONTENT, "utf8").digest("hex");
    expect(computed).toBe("0384ed7b35bc0dd753100c90240d99e468684d60f2c32df6df10fa13ebe4b14e");
  });
});

describe("LK-03: byte count matches recorded value", () => {
  it("UTF-8 byte length equals LUCY_KNOWLEDGE_META.byteCount (17126)", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.byteCount).toBe(17126);
    expect(report.byteCountMatch).toBe(true);
  });
});

describe("LK-04: line count matches recorded value", () => {
  it("trailing-newline-terminated line count equals 444", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.lineCount).toBe(444);
    expect(report.lineCountMatch).toBe(true);
  });
});

describe("LK-05: section count matches recorded value", () => {
  it("number of top-level # sections equals 17", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.sectionCount).toBe(17);
    expect(report.sectionCountMatch).toBe(true);
  });
});

describe("LK-06: no omitted sections", () => {
  it("every expected section name is present in the stored content", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.omittedSections).toEqual([]);
    expect(report.noOmittedSections).toBe(true);
  });
});

describe("LK-07: no added sections", () => {
  it("no section names are present that were not in the original document", () => {
    const report = verifyLucySourceIntegrity();
    expect(report.addedSections).toEqual([]);
    expect(report.noAddedSections).toBe(true);
  });
});

describe("LK-08: all 17 expected section names are present", () => {
  it.each(LUCY_KNOWLEDGE_EXPECTED_SECTIONS)("section '%s' is present in the stored content", (section) => {
    expect(LUCY_KNOWLEDGE_CONTENT).toContain(`# ${section}`);
  });
});

// ── LK-09..LK-10: Exact pricing values ───────────────────────────────────────

describe("LK-09: semaglutide pricing values match the Lucy document exactly", () => {
  const topic = getTopicByKey("semaglutide_pricing");

  it("topic exists in the catalog", () => {
    expect(topic).toBeDefined();
  });

  it("1-month price is $120", () => {
    expect(topic?.approvedText).toContain("$120");
  });

  it("3-month price is $80 per month", () => {
    expect(topic?.approvedText).toContain("$80 per month");
  });

  it("3-month total is $240", () => {
    expect(topic?.approvedText).toContain("$240 total");
  });

  it("6-month price is $78 per month", () => {
    expect(topic?.approvedText).toContain("$78 per month");
  });

  it("6-month total is $468", () => {
    expect(topic?.approvedText).toContain("$468 total");
  });
});

describe("LK-10: tirzepatide pricing values match the Lucy document exactly", () => {
  const topic = getTopicByKey("tirzepatide_pricing");

  it("topic exists in the catalog", () => {
    expect(topic).toBeDefined();
  });

  it("1-month price is $165", () => {
    expect(topic?.approvedText).toContain("$165");
  });

  it("3-month price is $150 per month", () => {
    expect(topic?.approvedText).toContain("$150 per month");
  });

  it("3-month total is $450", () => {
    expect(topic?.approvedText).toContain("$450 total");
  });

  it("6-month price is $147 per month", () => {
    expect(topic?.approvedText).toContain("$147 per month");
  });

  it("6-month total is $882", () => {
    expect(topic?.approvedText).toContain("$882 total");
  });
});

// ── LK-11..LK-12: Dose progressions ──────────────────────────────────────────

describe("LK-11: tirzepatide dose progression matches the Lucy document", () => {
  const topic = getTopicByKey("titration");

  it("topic exists in the catalog", () => {
    expect(topic).toBeDefined();
  });

  it("contains the complete tirzepatide dose progression", () => {
    expect(topic?.approvedText).toContain("2.5 mg");
    expect(topic?.approvedText).toContain("5 mg");
    expect(topic?.approvedText).toContain("7.5 mg");
    expect(topic?.approvedText).toContain("10 mg");
    expect(topic?.approvedText).toContain("12.5 mg");
    expect(topic?.approvedText).toContain("15 mg");
  });

  it("progression is stated as once weekly", () => {
    expect(topic?.approvedText).toContain("once weekly");
  });

  it("states that customers may request to titrate each month", () => {
    expect(topic?.approvedText).toContain("each month");
  });
});

describe("LK-12: semaglutide dose progression matches the Lucy document", () => {
  const topic = getTopicByKey("titration");

  it("contains the complete semaglutide dose progression", () => {
    expect(topic?.approvedText).toContain("0.25 mg");
    expect(topic?.approvedText).toContain("0.5 mg");
    expect(topic?.approvedText).toContain("1 mg");
    expect(topic?.approvedText).toContain("1.7 mg");
    expect(topic?.approvedText).toContain("2.4 mg");
  });
});

// ── LK-13..LK-14: Approved comparison language ───────────────────────────────

describe("LK-13: approved comparison language (tirzepatide > semaglutide) is in the catalog", () => {
  const topic = getTopicByKey("product_comparison");

  it("topic exists in the catalog", () => {
    expect(topic).toBeDefined();
  });

  it("states tirzepatide demonstrated greater average weight loss than semaglutide", () => {
    expect(topic?.approvedText).toContain("greater average weight loss");
  });

  it("states most of our customers choose tirzepatide", () => {
    expect(topic?.approvedText).toContain("Most of our customers choose tirzepatide");
  });

  it("states semaglutide is the more affordable option", () => {
    expect(topic?.approvedText).toContain("more affordable option");
  });

  it("states customer chooses the medication", () => {
    expect(topic?.approvedText).toContain("You choose which medication");
  });
});

describe("LK-14: provider_chooses_medication is in product_comparison prohibited claims", () => {
  const topic = getTopicByKey("product_comparison");

  it("prohibited claims include provider_chooses_medication", () => {
    expect(topic?.prohibitedClaims).toContain("provider_chooses_medication");
  });

  it("prohibited claims include personal_effectiveness_guarantee", () => {
    expect(topic?.prohibitedClaims).toContain("personal_effectiveness_guarantee");
  });

  it("prohibited claims include fewer_side_effects_guarantee", () => {
    expect(topic?.prohibitedClaims).toContain("fewer_side_effects_guarantee");
  });
});

// ── LK-15: All Lucy-v1 topics have legalStatus "approved" ────────────────────

describe("LK-15: all Lucy-v1 topics have legalStatus approved", () => {
  it("every topic in LUCY_V1_TOPIC_KEYS has legalStatus 'approved'", () => {
    for (const key of LUCY_V1_TOPIC_KEYS) {
      const topic = getTopicByKey(key);
      expect(topic, `topic ${key} should exist`).toBeDefined();
      expect(topic?.legalStatus, `topic ${key} legalStatus`).toBe("approved");
    }
  });

  it("every topic in LUCY_V1_TOPIC_KEYS has lucySourceVersion 'lucy-knowledge-v1'", () => {
    for (const key of LUCY_V1_TOPIC_KEYS) {
      const topic = getTopicByKey(key);
      expect(topic?.lucySourceVersion, `topic ${key} lucySourceVersion`).toBe("lucy-knowledge-v1");
    }
  });
});

// ── LK-16: Metadata is correct ───────────────────────────────────────────────

describe("LK-16: metadata has correct version, status, source; approvedBy/approvedAt are null (not yet supplied)", () => {
  it("version is lucy-knowledge-v1", () => {
    expect(LUCY_KNOWLEDGE_META.version).toBe("lucy-knowledge-v1");
  });

  it("status is approved", () => {
    expect(LUCY_KNOWLEDGE_META.status).toBe("approved");
  });

  it("source is medical_staff_and_legal_approved", () => {
    expect(LUCY_KNOWLEDGE_META.source).toBe("medical_staff_and_legal_approved");
  });

  it("approvedBy records owner attestation — not a named individual or invented value", () => {
    expect(LUCY_KNOWLEDGE_META.approvedBy).toBe("owner_attested_medical_staff_and_legal_approved");
  });

  it("approvedAt is null — document owner has not yet supplied an approval date", () => {
    expect(LUCY_KNOWLEDGE_META.approvedAt).toBeNull();
  });

  it("active is true", () => {
    expect(LUCY_KNOWLEDGE_META.active).toBe(true);
  });

  it("sectionCount is 17", () => {
    expect(LUCY_KNOWLEDGE_META.sectionCount).toBe(17);
  });
});

// ── LK-17: getPreviewEnabledTopics() includes all Lucy-v1 keys ───────────────

describe("LK-17: getPreviewEnabledTopics() includes all Lucy-v1 topic keys and excludes non-Lucy entries", () => {
  it("every LUCY_V1_TOPIC_KEY is in the preview-enabled set", () => {
    const enabledKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    for (const key of LUCY_V1_TOPIC_KEYS) {
      expect(enabledKeys.has(key), `${key} should be preview-enabled`).toBe(true);
    }
  });

  it("there are at least 8 preview-enabled topics", () => {
    expect(getPreviewEnabledTopics().length).toBeGreaterThanOrEqual(8);
  });

  it("first_month_offer IS preview-enabled — approved via lucy-promotion-v1", () => {
    const enabledKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(enabledKeys.has("first_month_offer")).toBe(true);
  });

  it("plan_inclusions IS preview-enabled (approved by owner)", () => {
    const enabledKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(enabledKeys.has("plan_inclusions")).toBe(true);
  });

  it("portal_help is NOT in Lucy's topic list — it's Sarah-only (a prospect has no portal account)", () => {
    const enabledKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(enabledKeys.has("portal_help")).toBe(false);
  });

  it("first_month_offer is in the catalog and is preview-enabled (lucy-promotion-v1)", () => {
    const topic = getTopicByKey("first_month_offer");
    expect(topic).toBeDefined();
    expect(topic?.enabledForPreview).toBe(true);
    expect(topic?.legalStatus).toBe("approved");
    expect(topic?.lucySourceVersion).toBe("lucy-promotion-v1");
  });

  it("plan_inclusions exists in the catalog and is preview-enabled", () => {
    const topic = getTopicByKey("plan_inclusions");
    expect(topic).toBeDefined();
    expect(topic?.enabledForPreview).toBe(true);
    expect(topic?.legalStatus).toBe("approved");
  });
});

// ── LK-18: Medical boundary topics exist in the catalog ──────────────────────

describe("LK-18: medical boundary entries exist in the catalog", () => {
  it("previous_prescriptions topic exists and is preview-enabled", () => {
    const topic = getTopicByKey("previous_prescriptions");
    expect(topic).toBeDefined();
    expect(topic?.enabledForPreview).toBe(true);
  });

  it("previous_prescriptions prohibits guaranteed_dose_continuation", () => {
    const topic = getTopicByKey("previous_prescriptions");
    expect(topic?.prohibitedClaims).toContain("guaranteed_dose_continuation");
  });

  it("weight_loss_expectations prohibits guaranteed_weight_loss", () => {
    const topic = getTopicByKey("weight_loss_expectations");
    expect(topic?.prohibitedClaims).toContain("guaranteed_weight_loss");
  });

  it("weight_loss_expectations prohibits personal_weight_loss_prediction", () => {
    const topic = getTopicByKey("weight_loss_expectations");
    expect(topic?.prohibitedClaims).toContain("personal_weight_loss_prediction");
  });

  it("insurance_payment topic exists and states no insurance accepted", () => {
    const topic = getTopicByKey("insurance_payment");
    expect(topic).toBeDefined();
    expect(topic?.approvedText).toContain("do not accept health insurance");
  });

  it("insurance_payment prohibits financing_approval_guarantee", () => {
    const topic = getTopicByKey("insurance_payment");
    expect(topic?.prohibitedClaims).toContain("financing_approval_guarantee");
  });
});

// ── LK-19..LK-20: No invented prices in pricing topics ───────────────────────

describe("LK-19: no invented prices in semaglutide_pricing approvedText", () => {
  const topic = getTopicByKey("semaglutide_pricing");

  it("approvedText explicitly prohibits inventing prices", () => {
    expect(topic?.approvedText).toContain("Never quote prices");
  });

  it("invented_price is in prohibited claims", () => {
    expect(topic?.prohibitedClaims).toContain("invented_price");
  });

  it("invented_discount is in prohibited claims", () => {
    expect(topic?.prohibitedClaims).toContain("invented_discount");
  });

  it("coupon_code is in prohibited claims", () => {
    expect(topic?.prohibitedClaims).toContain("coupon_code");
  });
});

describe("LK-20: no invented prices in tirzepatide_pricing approvedText", () => {
  const topic = getTopicByKey("tirzepatide_pricing");

  it("approvedText explicitly prohibits inventing prices", () => {
    expect(topic?.approvedText).toContain("Never quote prices");
  });

  it("invented_price is in prohibited claims", () => {
    expect(topic?.prohibitedClaims).toContain("invented_price");
  });

  it("invented_discount is in prohibited claims", () => {
    expect(topic?.prohibitedClaims).toContain("invented_discount");
  });

  it("coupon_code is in prohibited claims", () => {
    expect(topic?.prohibitedClaims).toContain("coupon_code");
  });
});

// ── Additional catalog-correctness assertions ─────────────────────────────────

describe("KNOWLEDGE_CATALOG structure", () => {
  it("every entry has a unique key", () => {
    const keys = KNOWLEDGE_CATALOG.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry has a non-empty approvedText", () => {
    for (const topic of KNOWLEDGE_CATALOG) {
      expect(topic.approvedText.length, `${topic.key} approvedText`).toBeGreaterThan(0);
    }
  });

  it("every entry has at least one prohibited claim", () => {
    for (const topic of KNOWLEDGE_CATALOG) {
      expect(topic.prohibitedClaims.length, `${topic.key} prohibitedClaims`).toBeGreaterThan(0);
    }
  });

  it("how_luma_works topic mentions 5 minutes (not 10)", () => {
    const topic = getTopicByKey("how_luma_works");
    expect(topic?.approvedText).toContain("5-minute");
    expect(topic?.approvedText).not.toContain("10-minute");
    expect(topic?.approvedText).not.toContain("10 minute");
  });
});
