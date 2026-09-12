const META_FLAG_NAMES = [
  "META_INGEST_ENABLED",
  "META_DEV_VIEW_ENABLED",
  "META_LUCY_ENABLED",
  "META_OUTBOUND_ENABLED",
  "META_COMMENT_AUTOMATION_ENABLED",
  "META_COMMENT_PUBLIC_REPLY_ENABLED",
  "META_UNIFIED_PRESENTATION_ENABLED",
] as const;

export type MetaFeatureFlagName = (typeof META_FLAG_NAMES)[number];
export type MetaFeatureFlags = Readonly<Record<MetaFeatureFlagName, boolean>>;

/**
 * Fail closed: only the exact value "true" enables a Meta capability. Missing,
 * malformed, mixed-case, or truthy-looking values all remain disabled.
 */
function parseMetaFlag(value: string | undefined): boolean {
  return value === "true";
}

export function readMetaFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
): MetaFeatureFlags {
  return Object.freeze(
    Object.fromEntries(
      META_FLAG_NAMES.map((name) => [name, parseMetaFlag(env[name])]),
    ) as Record<MetaFeatureFlagName, boolean>,
  );
}

export function isMetaFeatureEnabled(
  name: MetaFeatureFlagName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readMetaFeatureFlags(env)[name];
}

export { META_FLAG_NAMES };
