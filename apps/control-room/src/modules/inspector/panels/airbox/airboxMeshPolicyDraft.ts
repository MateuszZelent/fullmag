import type {
  JsonObject,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
} from "@/kernel/api/apiTypes";
import {
  changeQuantityInputUnit,
  parseQuantityInput,
  type QuantityUnit,
} from "@/kernel/authoring/object-edit/quantityInput";

export const AIRBOX_GRADING_MODES = ["auto", "geometric", "linear"] as const;
export type AirboxMeshPolicyLane = "fem" | "fdm";
export type AirboxLengthUnit = Extract<QuantityUnit, "m" | "mm" | "um" | "µm" | "μm" | "nm">;
export const AIRBOX_LENGTH_FIELDS = [
  "airboxHmax",
  "airboxHmin",
  "paddingX",
  "paddingY",
  "paddingZ",
  "airboxSizeX",
  "airboxSizeY",
  "airboxSizeZ",
  "airboxCenterX",
  "airboxCenterY",
  "airboxCenterZ",
] as const;
export type AirboxLengthPolicyField = (typeof AIRBOX_LENGTH_FIELDS)[number];

type AirboxGradingMode = (typeof AIRBOX_GRADING_MODES)[number];

export interface AirboxMeshPolicyDraft {
  authoredConfigPresent: boolean;
  airboxGradingAuthored: boolean;
  airboxGrading: AirboxGradingMode;
  airboxGrowthRate: string;
  airboxHmax: string;
  airboxHmin: string;
  configText: string;
  /** Last JSON projection shared by the structured and advanced editors. */
  syncedConfigText?: string;
  /** True after either editor has committed a validated JSON projection. */
  configSynchronized?: boolean;
  curvatureFactor: string;
  narrowRegionResolution: string;
  quantityUnits?: Partial<Record<AirboxLengthPolicyField, AirboxLengthUnit>>;
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
  /** Resource revision the draft was edited from; sent as expected_revision. */
  baseRevision?: number;
  /** Authored config the draft was edited from; decides whether a newer revision may be adopted. */
  baseConfigText?: string;
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
): AirboxMeshPolicyDraft {
  const config = resource.config ?? {};

  return {
    baseRevision: resource.revision,
    baseConfigText: formatUniverseMeshPolicyConfig(resource.config),
    authoredConfigPresent: resource.config !== null && resource.config !== undefined,
    airboxGradingAuthored: Object.hasOwn(config, "airbox_grading"),
    airboxGrading: readAirboxGrading(config.airbox_grading),
    airboxGrowthRate: readNumberText(config.airbox_growth_rate),
    airboxHmax: readNumberText(config.airbox_hmax),
    airboxHmin: readNumberText(config.airbox_hmin),
    configText: formatUniverseMeshPolicyConfig(resource.config),
    syncedConfigText: formatUniverseMeshPolicyConfig(resource.config),
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

export function draftFromEffectiveUniverseMeshPolicyResource(
  resource: MeshUniverseConfigResource,
): AirboxMeshPolicyDraft {
  const sourceConfig = resource.config ?? resource.effective_config ?? {};
  return {
    ...draftFromUniverseMeshPolicyResource({
      ...resource,
      config: sourceConfig,
    }),
    authoredConfigPresent: true,
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

export function draftIdentityKeyForUniverseMeshPolicyResource(): string {
  return "universe";
}

/**
 * The policy revision is the session mesh revision, which every scene commit
 * advances. A draft therefore adopts the latest revision when the authored
 * Universe policy itself is unchanged since the draft was opened; a real
 * concurrent policy edit keeps the old revision and still conflicts.
 */
export function rebaseAirboxMeshPolicyDraft(
  draft: AirboxMeshPolicyDraft,
  latest: MeshUniverseConfigResource | null,
): AirboxMeshPolicyDraft {
  if (
    !latest ||
    draft.baseConfigText === undefined ||
    draft.baseRevision === latest.revision ||
    formatUniverseMeshPolicyConfig(latest.config) !== draft.baseConfigText
  ) {
    return draft;
  }
  return { ...draft, baseRevision: latest.revision };
}

export function airboxMeshPolicyDraftDirty(
  draft: AirboxMeshPolicyDraft,
  baseDraft: AirboxMeshPolicyDraft,
): boolean {
  return !draftRecordsEqual(
    normalizeLengthDraftForComparison(draft) as unknown as Record<string, unknown>,
    normalizeLengthDraftForComparison(baseDraft) as unknown as Record<string, unknown>,
  );
}

function normalizeLengthDraftForComparison(
  draft: AirboxMeshPolicyDraft,
): AirboxMeshPolicyDraft {
  const normalized = {
    ...draft,
    quantityUnits: undefined,
    baseRevision: undefined,
    baseConfigText: undefined,
  };
  for (const field of AIRBOX_LENGTH_FIELDS) {
    const input = parseQuantityInput(
      draft[field],
      "length",
      draft.quantityUnits?.[field] ?? "m",
    );
    if (input.parseStatus === "valid" && input.parsedSI !== null) {
      normalized[field] = String(input.parsedSI);
    }
  }
  return normalized;
}

export function airboxMeshPolicyJsonError(configText: string): string | null {
  const parsed = parseConfig(configText);
  return parsed.ok ? null : parsed.error;
}

function synchronizeAirboxMeshPolicyJson(draft: AirboxMeshPolicyDraft): AirboxMeshPolicyDraft {
  if (draft.syncedConfigText === undefined || draft.configText === draft.syncedConfigText) return draft;
  const previous = parseConfig(draft.syncedConfigText);
  const next = parseConfig(draft.configText);
  if (!previous.ok || !next.ok) return draft;
  const project = (config: JsonObject) => draftFromUniverseMeshPolicyResource({ config, revision: 0 });
  const previousFields = project(previous.value);
  const nextFields = project(next.value);
  const changes: Partial<AirboxMeshPolicyDraft> = {};
  const resetUnits: Partial<Record<AirboxLengthPolicyField, AirboxLengthUnit>> = {};
  for (const key of Object.keys(nextFields) as (keyof AirboxMeshPolicyDraft)[]) {
    if (["baseRevision", "baseConfigText", "configText", "syncedConfigText", "configSynchronized", "authoredConfigPresent", "quantityUnits"].includes(key)) continue;
    if (!Object.is(previousFields[key], nextFields[key])) {
      let value = nextFields[key];
      if (isAirboxLengthPolicyField(key) && typeof value === "string") {
        const unit = draft.quantityUnits?.[key] ?? "m";
        if (unit !== "m") {
          const valueInSI = parseQuantityInput(value, "length", "m");
          if (valueInSI.parseStatus === "valid") {
            const displayed = changeQuantityInputUnit(valueInSI, unit);
            if (displayed.ok) {
              value = displayed.input.rawText;
            } else if (displayed.reason === "out-of-range") {
              // Keep the new JSON SI value readable if the selected display
              // unit cannot represent it. Reset that field's unit atomically.
              resetUnits[key] = "m";
            }
          }
        }
      }
      Object.assign(changes, { [key]: value });
    }
  }
  if (Object.keys(resetUnits).length > 0) {
    changes.quantityUnits = { ...draft.quantityUnits, ...resetUnits };
  }
  return { ...draft, ...changes, syncedConfigText: draft.configText, configSynchronized: true };
}

function isAirboxLengthPolicyField(
  field: keyof AirboxMeshPolicyDraft,
): field is AirboxLengthPolicyField {
  return AIRBOX_LENGTH_FIELDS.includes(field as AirboxLengthPolicyField);
}

export function updateAirboxMeshPolicyDraft(
  draft: AirboxMeshPolicyDraft,
  patch: Partial<AirboxMeshPolicyDraft>,
  options: { lane?: AirboxMeshPolicyLane } = {},
): AirboxMeshPolicyDraft {
  const next = { ...synchronizeAirboxMeshPolicyJson(draft), ...patch };
  if (Object.keys(patch).length === 1 && patch.configText !== undefined) {
    return synchronizeAirboxMeshPolicyJson(next);
  }
  // Presets may update JSON and structured controls together as one transaction.
  const formDraft = { ...next, syncedConfigText: next.configText, configSynchronized: false };
  const result = buildAirboxMeshPolicyFormRequest(formDraft, options);
  if ("error" in result || !result.request?.config) return formDraft;
  const previous = buildAirboxMeshPolicyFormRequest(draft, options);
  const parsed = parseConfig(draft.configText);
  let config = result.request.config;
  if (patch.configText === undefined && parsed.ok && "request" in previous && previous.request?.config) {
    config = { ...parsed.value };
    const before = previous.request.config;
    const after = result.request.config;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      if (Object.hasOwn(after, key)) config[key] = after[key]!;
      else delete config[key];
    }
  }
  const configText = formatUniverseMeshPolicyConfig(config);
  return { ...formDraft, configText, syncedConfigText: configText, configSynchronized: true };
}

export function updateAirboxLengthUnit(
  draft: AirboxMeshPolicyDraft,
  field: AirboxLengthPolicyField,
  unit: AirboxLengthUnit,
  options: { lane?: AirboxMeshPolicyLane } = {},
): AirboxMeshPolicyDraft {
  const currentUnit = draft.quantityUnits?.[field] ?? "m";
  const current = parseQuantityInput(draft[field], "length", currentUnit);
  const changed = changeQuantityInputUnit(current, unit);
  if (!changed.ok) return draft;
  return updateAirboxMeshPolicyDraft(
    draft,
    {
      [field]: changed.input.rawText,
      quantityUnits: { ...draft.quantityUnits, [field]: unit },
    },
    options,
  );
}

export function buildAirboxMeshPolicyReplaceRequest(
  draft: AirboxMeshPolicyDraft,
  options: { lane?: AirboxMeshPolicyLane } = {},
): ReturnType<typeof buildAirboxMeshPolicyFormRequest> {
  const synchronized = synchronizeAirboxMeshPolicyJson(draft);
  const result = buildAirboxMeshPolicyFormRequest(synchronized, options);
  if (!synchronized.configSynchronized || "error" in result || !result.request) return result;

  const parsed = parseConfig(synchronized.configText);
  if (!parsed.ok) return { error: parsed.error };
  const config = { ...parsed.value };
  if (
    Object.hasOwn(config, "mode") &&
    config.mode !== "auto" &&
    config.mode !== "manual"
  ) {
    return { error: "Domain mode must be auto or manual." };
  }
  if (options.lane !== "fdm" && config.airbox_grading !== undefined && !AIRBOX_GRADING_MODES.includes(config.airbox_grading as AirboxGradingMode)) {
    return { error: "Airbox grading must be auto, geometric, or linear." };
  }
  for (const key of ["padding", "size", "center"]) {
    const value = config[key];
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length !== 3 || value.some((component) => typeof component !== "number" || !Number.isFinite(component)))) {
      return { error: key + " must contain three finite SI values." };
    }
  }
  if (options.lane === "fdm") for (const key of FEM_ONLY_POLICY_KEYS) delete config[key];
  return { request: { config, expected_revision: draft.baseRevision } };
}

function buildAirboxMeshPolicyFormRequest(
  draft: AirboxMeshPolicyDraft,
  options: { lane?: AirboxMeshPolicyLane } = {},
):
  | { error: string }
  | { request: MeshUniverseConfigReplaceRequest | null } {
  const parsed = parseConfig(draft.configText);
  if (!parsed.ok) return { error: parsed.error };

  if (
    !draft.authoredConfigPresent &&
    isUntouchedNullAuthoredDraft(draft, parsed.value)
  ) {
    return { request: null };
  }

  const config = { ...parsed.value };
  const lane = options.lane ?? "fem";
  if (lane === "fdm") {
    for (const key of FEM_ONLY_POLICY_KEYS) delete config[key];
  } else {
    if (draft.airboxGradingAuthored) {
      config.airbox_grading = draft.airboxGrading;
    } else {
      delete config.airbox_grading;
    }

    const hmax = parsePositiveLength(
      draft.airboxHmax,
      "Airbox maximum element size",
      draft.quantityUnits?.airboxHmax ?? "m",
    );
    if (!hmax.ok) return { error: hmax.error };
    applyOptionalNumber(config, "airbox_hmax", hmax.value);

    const hmin = parsePositiveLength(
      draft.airboxHmin,
      "Airbox minimum element size",
      draft.quantityUnits?.airboxHmin ?? "m",
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
  }

  // Airbox mode
  const trimmedMode = draft.airboxMode.trim();
  if (trimmedMode) {
    config.mode = trimmedMode;
  } else {
    delete config.mode;
  }

  // Padding (vec3)
  const padding = parseLengthVector(
    [draft.paddingX, draft.paddingY, draft.paddingZ],
    [draft.quantityUnits?.paddingX ?? "m", draft.quantityUnits?.paddingY ?? "m", draft.quantityUnits?.paddingZ ?? "m"],
    ["Padding X", "Padding Y", "Padding Z"],
    "Padding",
  );
  if (!padding.ok) return { error: padding.error };
  if (padding.value !== null) {
    config.padding = padding.value;
  } else {
    delete config.padding;
  }

  const mode = trimmedMode || "auto";
  if (mode === "manual") {
    const size = parseLengthVector(
      [draft.airboxSizeX, draft.airboxSizeY, draft.airboxSizeZ],
      [draft.quantityUnits?.airboxSizeX ?? "m", draft.quantityUnits?.airboxSizeY ?? "m", draft.quantityUnits?.airboxSizeZ ?? "m"],
      ["Size X", "Size Y", "Size Z"],
      "Manual size",
      { required: true, positive: true },
    );
    if (!size.ok) return { error: size.error };
    const center = parseLengthVector(
      [draft.airboxCenterX, draft.airboxCenterY, draft.airboxCenterZ],
      [draft.quantityUnits?.airboxCenterX ?? "m", draft.quantityUnits?.airboxCenterY ?? "m", draft.quantityUnits?.airboxCenterZ ?? "m"],
      ["Center X", "Center Y", "Center Z"],
      "Manual center",
    );
    if (!center.ok) return { error: center.error };
    config.size = size.value!;
    if (center.value !== null) config.center = center.value;
    else delete config.center;
  } else {
    // Automatic bounds are derived from accepted geometry. Do not manufacture
    // or retain zero-filled manual extents in an automatic policy.
    delete config.size;
    delete config.center;
  }

  return { request: { config, expected_revision: draft.baseRevision } };
}

const FEM_ONLY_POLICY_KEYS = [
  "airbox_grading",
  "airbox_growth_rate",
  "airbox_hmax",
  "airbox_hmin",
  "curvature_factor",
  "narrow_region_resolution",
] as const;

function isUntouchedNullAuthoredDraft(
  draft: AirboxMeshPolicyDraft,
  parsedConfig: JsonObject,
): boolean {
  return (
    draft.airboxGrading === "auto" &&
    !draft.airboxGradingAuthored &&
    draft.airboxGrowthRate === "" &&
    draft.airboxHmax === "" &&
    draft.airboxHmin === "" &&
    Object.keys(parsedConfig).length === 0 &&
    draft.curvatureFactor === "" &&
    draft.narrowRegionResolution === "" &&
    draft.paddingX === "" &&
    draft.paddingY === "" &&
    draft.paddingZ === "" &&
    draft.airboxMode === "" &&
    draft.airboxSizeX === "" &&
    draft.airboxSizeY === "" &&
    draft.airboxSizeZ === "" &&
    draft.airboxCenterX === "" &&
    draft.airboxCenterY === "" &&
    draft.airboxCenterZ === ""
  );
}

function readAirboxGrading(value: unknown): AirboxGradingMode {
  return AIRBOX_GRADING_MODES.includes(value as AirboxGradingMode)
    ? (value as AirboxGradingMode)
    : "auto";
}

function readNumberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed;
  }
  return value == null ? "" : JSON.stringify(value);
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
    if (key === "syncedConfigText" || key === "configSynchronized") continue;
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

function parsePositiveLength(
  value: string,
  label: string,
  unit: AirboxLengthUnit,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const parsed = parseOptionalLength(value, label, unit);
  if (!parsed.ok) return parsed;
  if (parsed.value !== null && parsed.value <= 0) {
    return { error: `${label} must be greater than 0.`, ok: false };
  }
  return parsed;
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

function parseOptionalLength(
  value: string,
  label: string,
  unit: AirboxLengthUnit,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const parsed = parseQuantityInput(value, "length", unit);
  if (parsed.parseStatus === "empty") return { ok: true, value: null };
  if (parsed.parseStatus !== "valid" || parsed.parsedSI === null) {
    return {
      error: `${label} must be a finite length with a supported unit.`,
      ok: false,
    };
  }
  return { ok: true, value: parsed.parsedSI };
}

function parseLengthVector(
  values: readonly [string, string, string],
  units: readonly [AirboxLengthUnit, AirboxLengthUnit, AirboxLengthUnit],
  labels: readonly [string, string, string],
  vectorLabel: string,
  options: { positive?: boolean; required?: boolean } = {},
): { ok: true; value: [number, number, number] | null } | { error: string; ok: false } {
  const components: (number | null)[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const component = parseOptionalLength(
      values[index]!,
      labels[index]!,
      units[index]!,
    );
    if (!component.ok) return component;
    components.push(component.value);
  }
  if (components.every((value) => value === null)) {
    return options.required
      ? { error: `${vectorLabel} requires three explicit components.`, ok: false }
      : { ok: true, value: null };
  }
  if (components.some((value) => value === null)) {
    return { error: `${vectorLabel} requires all three explicit components.`, ok: false };
  }
  const vector = components as [number, number, number];
  if (options.positive && vector.some((value) => value <= 0)) {
    return { error: `${vectorLabel} components must be greater than 0.`, ok: false };
  }
  return { ok: true, value: vector };
}
