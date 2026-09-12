import { describe, expect, it } from "vitest";
import {
  isMetaFeatureEnabled,
  META_FLAG_NAMES,
  readMetaFeatureFlags,
} from "./feature-flags";

describe("Meta feature flags", () => {
  it("defaults every Meta capability to disabled", () => {
    const flags = readMetaFeatureFlags({});

    expect(Object.keys(flags)).toEqual(META_FLAG_NAMES);
    expect(Object.values(flags).every((enabled) => enabled === false)).toBe(
      true,
    );
  });

  it.each(["1", "yes", "TRUE", " true", "true ", "false", ""])(
    "fails closed for %j",
    (value) => {
      expect(
        isMetaFeatureEnabled("META_OUTBOUND_ENABLED", {
          META_OUTBOUND_ENABLED: value,
        }),
      ).toBe(false);
    },
  );

  it("enables only the explicitly true flag", () => {
    const flags = readMetaFeatureFlags({
      META_INGEST_ENABLED: "true",
      META_OUTBOUND_ENABLED: "false",
    });

    expect(flags.META_INGEST_ENABLED).toBe(true);
    expect(flags.META_OUTBOUND_ENABLED).toBe(false);
    expect(flags.META_LUCY_ENABLED).toBe(false);
  });

  it("returns an immutable snapshot", () => {
    const flags = readMetaFeatureFlags({ META_DEV_VIEW_ENABLED: "true" });

    expect(Object.isFrozen(flags)).toBe(true);
  });
});
