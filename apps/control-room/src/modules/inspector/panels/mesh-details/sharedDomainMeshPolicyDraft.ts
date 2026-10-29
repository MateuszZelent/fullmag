import type { JsonObject } from "@/kernel/api/apiTypes";

export interface SharedDomainPolicyDraft {
  authoredPresent: boolean;
  configText: string;
  curvatureFactor: string;
  growthRate: string;
  hMax: string;
  hMin: string;
  narrowRegionResolution: string;
  optimize: boolean;
  /** Authored Gmsh optimizer kept when the checkbox stays enabled. */
  optimizeMethod: string;
}

// The policy wire format is ScriptBuilderMeshState: sizes are authored text,
// `optimize` names a Gmsh optimizer and an empty string disables it. Each UI
// field writes its canonical key unless the loaded policy authored the
// COMSOL-style alias instead.
const DEFAULT_OPTIMIZE_METHOD = "Netgen";
const SHARED_DOMAIN_TEXT_FIELDS = [
  {
    alias: "maximum_element_size",
    allowAuto: true,
    draftKey: "hMax",
    key: "hmax",
    label: "Global maximum element size (h_max)",
    required: true,
  },
  {
    alias: "minimum_element_size",
    allowAuto: false,
    draftKey: "hMin",
    key: "hmin",
    label: "Global minimum element size (h_min)",
    required: true,
  },
  {
    alias: "maximum_element_growth_rate",
    allowAuto: false,
    draftKey: "growthRate",
    key: "growth_rate",
    label: "Element growth rate",
    required: true,
  },
  {
    alias: null,
    allowAuto: false,
    draftKey: "curvatureFactor",
    key: "curvature_factor",
    label: "Curvature factor",
    required: false,
  },
  {
    alias: null,
    allowAuto: false,
    draftKey: "narrowRegionResolution",
    key: "narrow_region_resolution",
    label: "Narrow region resolution",
    required: false,
  },
] as const;

// Keys an older revision of this panel wrote; the backend ignores them.
const LEGACY_SHARED_DOMAIN_KEYS = ["h_max", "h_min"] as const;

export interface SharedDomainResourceLike {
  config?: Record<string, unknown> | null;
  effective_config?: Record<string, unknown> | null;
  revision?: number;
}

function readPositiveNumberString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "";
}

export function formatPolicyJson(
  config: Record<string, unknown> | null | undefined,
): string {
  if (!config || Object.keys(config).length === 0) return "{}";
  return JSON.stringify(config, null, 2);
}

export function readAuthoredText(
  config: Record<string, unknown>,
  key: string,
  alias: string | null,
): string {
  const primary = readPositiveNumberString(config[key]);
  if (primary || !alias) return primary;
  return readPositiveNumberString(config[alias]);
}

export function draftFromSharedDomainResource(
  resource: SharedDomainResourceLike | null,
): SharedDomainPolicyDraft {
  const config = resource?.config ?? {};
  const optimizeMethod =
    typeof config.optimize === "string" ? config.optimize.trim() : "";
  const draft: SharedDomainPolicyDraft = {
    authoredPresent: Boolean(
      resource?.config && Object.keys(resource.config).length > 0,
    ),
    configText: formatPolicyJson(resource?.config),
    curvatureFactor: "",
    growthRate: "",
    hMax: "",
    hMin: "",
    narrowRegionResolution: "",
    optimize: optimizeMethod !== "",
    optimizeMethod,
  };
  for (const field of SHARED_DOMAIN_TEXT_FIELDS) {
    draft[field.draftKey] = readAuthoredText(config, field.key, field.alias);
  }
  return draft;
}

export function draftFromEffectiveSharedDomainResource(
  resource: SharedDomainResourceLike | null,
): SharedDomainPolicyDraft {
  const source = resource?.config ?? resource?.effective_config ?? {};
  return {
    ...draftFromSharedDomainResource({
      config: source,
      effective_config: resource?.effective_config ?? null,
      revision: resource?.revision ?? 0,
    }),
    authoredPresent: true,
  };
}

export function isSharedDomainDraftDirty(
  left: SharedDomainPolicyDraft,
  right: SharedDomainPolicyDraft,
): boolean {
  return (
    left.hMax !== right.hMax ||
    left.hMin !== right.hMin ||
    left.growthRate !== right.growthRate ||
    left.curvatureFactor !== right.curvatureFactor ||
    left.narrowRegionResolution !== right.narrowRegionResolution ||
    left.optimize !== right.optimize ||
    left.configText !== right.configText
  );
}

export function buildSharedDomainPolicyConfig(
  draft: SharedDomainPolicyDraft,
): { config: JsonObject; ok: true } | { error: string; ok: false } {
  let base: JsonObject = {};
  try {
    const parsed = JSON.parse(draft.configText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Shared-domain mesh policy JSON must be an object.",
        ok: false,
      };
    }
    base = { ...(parsed as JsonObject) };
  } catch {
    return {
      error: "Shared-domain mesh policy JSON must be valid JSON.",
      ok: false,
    };
  }

  for (const key of LEGACY_SHARED_DOMAIN_KEYS) delete base[key];

  for (const field of SHARED_DOMAIN_TEXT_FIELDS) {
    const trimmed = draft[field.draftKey].trim();
    const writesAlias =
      field.alias !== null &&
      readPositiveNumberString(base[field.key]) === "" &&
      readPositiveNumberString(base[field.alias]) !== "";
    const target = writesAlias && field.alias ? field.alias : field.key;
    if (!trimmed) {
      // Required ScriptBuilder fields are empty strings, optional ones absent.
      if (target === field.key && field.required) base[target] = "";
      else delete base[target];
      continue;
    }
    if (!(field.allowAuto && trimmed.toLowerCase() === "auto")) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { error: `${field.label} must be greater than 0.`, ok: false };
      }
    }
    base[target] = trimmed;
  }

  base.optimize = draft.optimize
    ? draft.optimizeMethod || DEFAULT_OPTIMIZE_METHOD
    : "";
  return { config: base, ok: true };
}
