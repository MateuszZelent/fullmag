import type {
  JsonObject,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
} from "@/kernel/api/apiTypes";

export const AIRBOX_GRADING_MODES = ["auto", "geometric", "linear"] as const;

type AirboxGradingMode = (typeof AIRBOX_GRADING_MODES)[number];

export interface AirboxMeshPolicyDraft {
  airboxGrading: AirboxGradingMode;
  airboxGrowthRate: string;
  airboxHmax: string;
  airboxHmin: string;
  configText: string;
}

export function defaultUniverseMeshPolicyResource(): MeshUniverseConfigResource {
  return {
    config: null,
    revision: 0,
  };
}

export function formatUniverseMeshPolicyConfig(
  config: JsonObject | null | undefined,
): string {
  if (!config || Object.keys(config).length === 0) return "{}";
  return JSON.stringify(config, null, 2);
}

export function draftFromUniverseMeshPolicyResource(
  resource: MeshUniverseConfigResource,
): AirboxMeshPolicyDraft {
  const config = resource.config ?? {};

  return {
    airboxGrading: readAirboxGrading(config.airbox_grading),
    airboxGrowthRate: readNumberText(config.airbox_growth_rate),
    airboxHmax: readNumberText(config.airbox_hmax),
    airboxHmin: readNumberText(config.airbox_hmin),
    configText: formatUniverseMeshPolicyConfig(config),
  };
}

export function draftKeyForUniverseMeshPolicyResource(
  resource: MeshUniverseConfigResource,
): string {
  return [
    resource.revision,
    formatUniverseMeshPolicyConfig(resource.config),
  ].join(":");
}

export function buildAirboxMeshPolicyReplaceRequest(
  draft: AirboxMeshPolicyDraft,
):
  | { error: string }
  | { request: MeshUniverseConfigReplaceRequest } {
  const parsed = parseConfig(draft.configText);
  if (!parsed.ok) return { error: parsed.error };

  const config = { ...parsed.value };
  config.airbox_grading = draft.airboxGrading;

  const hmax = parsePositiveNumber(
    draft.airboxHmax,
    "Airbox maximum element size",
  );
  if (!hmax.ok) return { error: hmax.error };
  applyOptionalNumber(config, "airbox_hmax", hmax.value);

  const hmin = parsePositiveNumber(
    draft.airboxHmin,
    "Airbox minimum element size",
  );
  if (!hmin.ok) return { error: hmin.error };
  applyOptionalNumber(config, "airbox_hmin", hmin.value);

  const growthRate = parsePositiveNumber(
    draft.airboxGrowthRate,
    "Airbox growth rate",
  );
  if (!growthRate.ok) return { error: growthRate.error };
  applyOptionalNumber(config, "airbox_growth_rate", growthRate.value);

  return { request: { config } };
}

function readAirboxGrading(value: unknown): AirboxGradingMode {
  return AIRBOX_GRADING_MODES.includes(value as AirboxGradingMode)
    ? (value as AirboxGradingMode)
    : "auto";
}

function readNumberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function parseConfig(
  configText: string,
): { ok: true; value: JsonObject } | { error: string; ok: false } {
  try {
    const parsed = JSON.parse(configText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Universe mesh policy config must be a JSON object.",
        ok: false,
      };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch {
    return {
      error: "Universe mesh policy config must be a JSON object.",
      ok: false,
    };
  }
}

function parsePositiveNumber(
  value: string,
  label: string,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      error: `${label} must be greater than 0.`,
      ok: false,
    };
  }

  return { ok: true, value: parsed };
}

function applyOptionalNumber(
  config: JsonObject,
  key: string,
  value: number | null,
): void {
  if (value === null) {
    delete config[key];
    return;
  }

  config[key] = value;
}
