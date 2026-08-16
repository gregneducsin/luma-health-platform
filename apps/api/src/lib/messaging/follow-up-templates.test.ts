import { describe, it, expect } from "vitest";
import { renderFollowUpMessage, renderAbandonedCartOpener, renderMetaLeadOpener, type FollowUpMessageStep } from "./follow-up-templates.js";

const STEPS: FollowUpMessageStep[] = ["provider_check_in", "intake_questions_check_in"];

describe("renderFollowUpMessage", () => {
  for (const step of STEPS) {
    it(`${step}: has exactly one trailing question mark, no em dash`, () => {
      const text = renderFollowUpMessage(step, "Jamie");
      expect((text.match(/\?/g) ?? []).length).toBe(1);
      expect(text.trim().endsWith("?")).toBe(true);
      expect(text).not.toMatch(/—|--/);
    });

    it(`${step}: interpolates the first name`, () => {
      const text = renderFollowUpMessage(step, "Jamie");
      expect(text).toContain("Jamie");
    });

    it(`${step}: falls back to "there" for a blank first name`, () => {
      const text = renderFollowUpMessage(step, "   ");
      expect(text).toContain("there");
    });
  }

  it("provider_check_in introduces Lucy by name and company", () => {
    const text = renderFollowUpMessage("provider_check_in", "Jamie");
    expect(text).toContain("this is Lucy with Luma Health");
  });
});

describe("renderAbandonedCartOpener", () => {
  it("has exactly one trailing question mark, no em dash", () => {
    const text = renderAbandonedCartOpener("Jamie");
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text.trim().endsWith("?")).toBe(true);
    expect(text).not.toMatch(/—|--/);
  });

  it("mentions the $20 offer and does not include a link", () => {
    const text = renderAbandonedCartOpener("Jamie");
    expect(text).toContain("$20 off");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderAbandonedCartOpener("Jamie")).toContain("Jamie");
    expect(renderAbandonedCartOpener("  ")).toContain("there");
  });
});

describe("renderMetaLeadOpener", () => {
  it("has no question mark and no em dash", () => {
    const text = renderMetaLeadOpener("Jamie");
    expect(text).not.toContain("?");
    expect(text).not.toMatch(/—|--/);
  });

  it("asks about state and does not include a link", () => {
    const text = renderMetaLeadOpener("Jamie");
    expect(text.toLowerCase()).toContain("state");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("does not imply the patient already started signing up", () => {
    const text = renderMetaLeadOpener("Jamie");
    expect(text.toLowerCase()).not.toContain("started");
    expect(text.toLowerCase()).not.toContain("finish");
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderMetaLeadOpener("Jamie")).toContain("Jamie");
    expect(renderMetaLeadOpener("  ")).toContain("there");
  });
});
