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
  curvatureFactor: string;
  narrowRegionResolution: string;
  paddingX: string;
  paddingY: string;
  paddingZ: string;
  airboxMode: string;
  airboxSizeX: string;
  airboxSizeY: string;
  airboxSizeZ: string;
  airboxCenterX: string;
  airboxCenterY: string;
  airboxCenterZ: string;
}

export function defaultUniverseMeshPolicyResource(): MeshUniverseConfigResource {
  return {
    config: null,
    effective_config: null,
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
  options: {
    effectiveTarget?: JsonObject | null | undefined;
  } = {},
): AirboxMeshPolicyDraft {
  const config = {
    ...defaultUniverseMeshPolicyConfig(),
    ...targetConfigFromEffectiveAirbox(options.effectiveTarget),
    ...(resource.effective_config ?? {}),
    ...(resource.config ?? {}),
  };

  return {
    airboxGrading: readAirboxGrading(config.airbox_grading),
    airboxGrowthRate: readNumberText(config.airbox_growth_rate),
    airboxHmax: readNumberText(config.airbox_hmax),
    airboxHmin: readNumberText(config.airbox_hmin),
    configText: formatUniverseMeshPolicyConfig(resource.config),
    curvatureFactor: readNumberText(config.curvature_factor),
    narrowRegionResolution: readNumberText(config.narrow_region_resolution),
    paddingX: readVec3Component(config.padding, 0),
    paddingY: readVec3Component(config.padding, 1),
    paddingZ: readVec3Component(config.padding, 2),
    airboxMode: readStringText(config.mode),
    airboxSizeX: readVec3Component(config.size, 0),
    airboxSizeY: readVec3Component(config.size, 1),
    airboxSizeZ: readVec3Component(config.size, 2),
    airboxCenterX: readVec3Component(config.center, 0),
    airboxCenterY: readVec3Component(config.center, 1),
    airboxCenterZ: readVec3Component(config.center, 2),
  };
}

function defaultUniverseMeshPolicyConfig(): JsonObject {
  return {
    airbox_grading: "geometric",
    airbox_growth_rate: 1.3,
    mode: "auto",
    padding: [0, 0, 0],
  };
}

function targetConfigFromEffectiveAirbox(
  target: JsonObject | null | undefined,
): JsonObject {
  if (!target) return {};
  const config: JsonObject = {};
  const hmax = target.maximum_element_size ?? target.hmax;
  const hmin = target.minimum_element_size ?? target.hmin;
  const growthRate = target.growth_rate ?? target.maximum_element_growth_rate;
  if (isFiniteNumberLike(hmax)) config.airbox_hmax = hmax;
  if (isFiniteNumberLike(hmin)) config.airbox_hmin = hmin;
  if (isFiniteNumberLike(growthRate)) config.airbox_growth_rate = growthRate;
  return config;
}

export function draftKeyForUniverseMeshPolicyResource(
  resource: MeshUniverseConfigResource,
  options: {
    effectiveTarget?: JsonObject | null | undefined;
  } = {},
): string {
  const effectiveTarget = targetConfigFromEffectiveAirbox(options.effectiveTarget);
  return [
    resource.revision,
    formatUniverseMeshPolicyConfig(resource.config),
    formatUniverseMeshPolicyConfig(resource.effective_config),
    formatUniverseMeshPolicyConfig(effectiveTarget),
  ].join(":");
}

export function draftIdentityKeyForUniverseMeshPolicyResource(): string {
  return "universe";
}

export function airboxMeshPolicyDraftDirty(
  draft: AirboxMeshPolicyDraft,
  baseDraft: AirboxMeshPolicyDraft,
): boolean {
  return !draftRecordsEqual(
    draft as unknown as Record<string, unknown>,
    baseDraft as unknown as Record<string, unknown>,
  );
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
    "Maximum element growth rate",
  );
  if (!growthRate.ok) return { error: growthRate.error };
  applyOptionalNumber(config, "airbox_growth_rate", growthRate.value);

  const curvature = parsePositiveNumber(
    draft.curvatureFactor,
    "Curvature factor",
  );
  if (!curvature.ok) return { error: curvature.error };
  applyOptionalNumber(config, "curvature_factor", curvature.value);

  const narrowRegion = parsePositiveNumber(
    draft.narrowRegionResolution,
    "Resolution of narrow regions",
  );
  if (!narrowRegion.ok) return { error: narrowRegion.error };
  applyOptionalNumber(config, "narrow_region_resolution", narrowRegion.value);

  // Airbox mode
  const trimmedMode = draft.airboxMode.trim();
  if (trimmedMode) {
    config.mode = trimmedMode;
  } else {
    delete config.mode;
  }

  // Padding (vec3)
  const padX = parseOptionalNumber(draft.paddingX, "Padding X");
  if (!padX.ok) return { error: padX.error };
  const padY = parseOptionalNumber(draft.paddingY, "Padding Y");
  if (!padY.ok) return { error: padY.error };
  const padZ = parseOptionalNumber(draft.paddingZ, "Padding Z");
  if (!padZ.ok) return { error: padZ.error };
  if (padX.value !== null || padY.value !== null || padZ.value !== null) {
    config.padding = [padX.value ?? 0, padY.value ?? 0, padZ.value ?? 0];
  } else {
    delete config.padding;
  }

  // Airbox size (vec3)
  const sizeX = parseOptionalNumber(draft.airboxSizeX, "Size X");
  if (!sizeX.ok) return { error: sizeX.error };
  const sizeY = parseOptionalNumber(draft.airboxSizeY, "Size Y");
  if (!sizeY.ok) return { error: sizeY.error };
  const sizeZ = parseOptionalNumber(draft.airboxSizeZ, "Size Z");
  if (!sizeZ.ok) return { error: sizeZ.error };
  if (sizeX.value !== null || sizeY.value !== null || sizeZ.value !== null) {
    config.size = [sizeX.value ?? 0, sizeY.value ?? 0, sizeZ.value ?? 0];
  } else {
    delete config.size;
  }

  // Airbox center (vec3)
  const cenX = parseOptionalNumber(draft.airboxCenterX, "Center X");
  if (!cenX.ok) return { error: cenX.error };
  const cenY = parseOptionalNumber(draft.airboxCenterY, "Center Y");
  if (!cenY.ok) return { error: cenY.error };
  const cenZ = parseOptionalNumber(draft.airboxCenterZ, "Center Z");
  if (!cenZ.ok) return { error: cenZ.error };
  if (cenX.value !== null || cenY.value !== null || cenZ.value !== null) {
    config.center = [cenX.value ?? 0, cenY.value ?? 0, cenZ.value ?? 0];
  } else {
    delete config.center;
  }

  return { request: { config } };
}

function readAirboxGrading(value: unknown): AirboxGradingMode {
  return AIRBOX_GRADING_MODES.includes(value as AirboxGradingMode)
    ? (value as AirboxGradingMode)
    : "auto";
}

function isFiniteNumberLike(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Number(trimmed));
}

function readNumberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return Number.isFinite(Number(trimmed)) ? trimmed : "";
  }
  return "";
}

function readStringText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readVec3Component(value: unknown, index: number): string {
  if (Array.isArray(value) && value.length > index) {
    const component = value[index];
    if (typeof component === "number" && Number.isFinite(component)) {
      return String(component);
    }
  }
  return "";
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

function draftRecordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (key === "configText") {
      if (!jsonTextEquivalent(left[key], right[key])) return false;
    } else if (!draftValueEquivalent(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function jsonTextEquivalent(left: unknown, right: unknown): boolean {
  const leftParsed = parseConfig(typeof left === "string" ? left : "");
  const rightParsed = parseConfig(typeof right === "string" ? right : "");
  if (!leftParsed.ok || !rightParsed.ok) return Object.is(left, right);
  return normalizedJsonValue(leftParsed.value) === normalizedJsonValue(rightParsed.value);
}

function normalizedJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(normalizedJsonValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${normalizedJsonValue(nested)}`)
      .join(",")}}`;
  }
  const numeric = finiteNumericValue(value);
  return numeric !== null ? `number:${numeric}` : JSON.stringify(value);
}

function draftValueEquivalent(left: unknown, right: unknown): boolean {
  const leftNumber = finiteNumericValue(left);
  const rightNumber = finiteNumericValue(right);
  if (leftNumber !== null && rightNumber !== null) {
    return Object.is(leftNumber, rightNumber);
  }
  return Object.is(left, right);
}

function finiteNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
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

function parseOptionalNumber(
  value: string,
  label: string,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      error: `${label} must be a finite number.`,
      ok: false,
    };
  }

  return { ok: true, value: parsed };
}
