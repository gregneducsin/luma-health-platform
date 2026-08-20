import { describe, it, expect } from "vitest";
import { getPreviewEnabledTopics, getSarahEnabledTopics, getTopicByKey } from "./knowledge-catalog.js";

describe("Lucy/Sarah topic-list separation", () => {
  it("Lucy's topic list excludes portal_help (a prospect has no portal account)", () => {
    const lucyKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(lucyKeys.has("portal_help")).toBe(false);
  });

  it("Sarah's topic list includes portal_help", () => {
    const sarahKeys = new Set(getSarahEnabledTopics().map((t) => t.key));
    expect(sarahKeys.has("portal_help")).toBe(true);
  });

  it("Sarah's topic list uses how_luma_works_after_purchase, not the enrollment-oriented how_luma_works", () => {
    const sarahKeys = new Set(getSarahEnabledTopics().map((t) => t.key));
    expect(sarahKeys.has("how_luma_works_after_purchase")).toBe(true);
    expect(sarahKeys.has("how_luma_works")).toBe(false);
  });

  it("Lucy's topic list uses how_luma_works, not Sarah's post-purchase version", () => {
    const lucyKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(lucyKeys.has("how_luma_works")).toBe(true);
    expect(lucyKeys.has("how_luma_works_after_purchase")).toBe(false);
  });

  it("existing_customer_current_rate is Sarah-only — Lucy talks pricing with prospects who haven't committed yet", () => {
    const sarahKeys = new Set(getSarahEnabledTopics().map((t) => t.key));
    const lucyKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(sarahKeys.has("existing_customer_current_rate")).toBe(true);
    expect(lucyKeys.has("existing_customer_current_rate")).toBe(false);
  });

  it("existing_customer_current_rate's approved text carries no dollar figure — reassurance only, never a new pricing claim", () => {
    const topic = getTopicByKey("existing_customer_current_rate");
    expect(topic).toBeDefined();
    expect(topic!.approvedText).not.toMatch(/\$\d/);
  });

  it("how_luma_works_after_purchase does not repeat the pre-purchase enrollment framing", () => {
    const topic = getTopicByKey("how_luma_works_after_purchase");
    expect(topic).toBeDefined();
    const text = topic!.approvedText.toLowerCase();
    expect(text).not.toContain("select your preferred medication");
    expect(text).not.toContain("complete the");
    expect(text).not.toContain("questionnaire");
    expect(text).not.toContain("guide the customer toward");
  });

  it("how_luma_works_after_purchase and how_luma_works are both approved and preview-enabled", () => {
    const afterPurchase = getTopicByKey("how_luma_works_after_purchase");
    const enrollment = getTopicByKey("how_luma_works");
    expect(afterPurchase?.legalStatus).toBe("approved");
    expect(afterPurchase?.enabledForPreview).toBe(true);
    expect(enrollment?.legalStatus).toBe("approved");
    expect(enrollment?.enabledForPreview).toBe(true);
  });

  it("medication_onset_timeline and appetite_hunger_management are Sarah-only — approved and available to Sarah, but excluded from Lucy's topic list", () => {
    const lucyKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    const sarahKeys = new Set(getSarahEnabledTopics().map((t) => t.key));
    for (const key of ["medication_onset_timeline", "appetite_hunger_management"]) {
      const topic = getTopicByKey(key);
      expect(topic?.legalStatus).toBe("approved");
      expect(topic?.clinicalStatus).toBe("approved");
      expect(sarahKeys.has(key)).toBe(true);
      expect(lucyKeys.has(key)).toBe(false);
    }
  });

  it("medication_onset_timeline and appetite_hunger_management avoid words Sarah's own post-check unconditionally rejects (dose/mg/side effect/symptom/diagnos/contraindicat)", () => {
    const forbidden = /\bdos(e|es|age|ages|ing)\b|\b\d+\s?mg\b|\bside.?effect|\bsymptom|\bdiagnos(e|is|ed|ing)\b|\bcontraindicat(e|ed|es|ing|ion|ions)\b/i;
    for (const key of ["medication_onset_timeline", "appetite_hunger_management"]) {
      const topic = getTopicByKey(key);
      expect(topic?.approvedText).toBeDefined();
      expect(forbidden.test(topic!.approvedText)).toBe(false);
    }
  });
});
