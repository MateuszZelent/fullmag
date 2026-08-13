export type AnalysisSurface =
  | "dynamics"
  | "resonance-fmr"
  | "dispersion"
  | "hysteresis"
  | "comparison";

export type AnalysisSubview =
  | "comparison.sources"
  | "dispersion.branches"
  | "dispersion.driven-map"
  | "dispersion.modal"
  | "dynamics.s-k-f"
  | "dynamics.temporal-fft"
  | "dynamics.time-traces"
  | "hysteresis.branches"
  | "hysteresis.loop"
  | "resonance.eigenmodes"
  | "resonance.frequency-response"
  | "resonance.modal-driven";

export const ANALYSIS_SUBVIEWS = Object.freeze({
  comparison: ["comparison.sources"],
  dispersion: ["dispersion.modal", "dispersion.driven-map", "dispersion.branches"],
  dynamics: ["dynamics.time-traces", "dynamics.temporal-fft", "dynamics.s-k-f"],
  hysteresis: ["hysteresis.loop", "hysteresis.branches"],
  "resonance-fmr": ["resonance.eigenmodes", "resonance.frequency-response", "resonance.modal-driven"],
} as const satisfies Readonly<Record<AnalysisSurface, readonly AnalysisSubview[]>>);

export type AnalysisActiveSubviews = Record<AnalysisSurface, AnalysisSubview>;

export interface AnalysisDescriptorPreference {
  selectedSeriesIds: string[];
  displayUnits: Record<string, string>;
  range: { fromSI: number; toSI: number } | null;
}

export interface AnalysisViewPreferencesV2 {
  schemaVersion: 2;
  activeSurface: AnalysisSurface;
  activeSubviews: AnalysisActiveSubviews;
  selectedDatasetRef: string | null;
  descriptorPreferences: Record<string, AnalysisDescriptorPreference>;
}

export const ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY = "fm:analysis-view-preferences:v2";
const SURFACES: readonly AnalysisSurface[] = ["dynamics", "resonance-fmr", "dispersion", "hysteresis", "comparison"];
const MAX_DESCRIPTORS = 50;
const MAX_DESCRIPTOR_LENGTH = 160;
const MAX_SERIES = 100;
const MAX_UNITS = 40;
const MAX_STORED_BYTES = 256 * 1024;

export function analysisDescriptorId(identity:
  | { kind: "dataset"; surface: AnalysisSurface; datasetRef: string | null }
  | { kind: "artifact"; surface: "resonance-fmr" | "dispersion"; resourceKey: string }
  | { kind: "comparison"; primaryDatasetRef: string | null; secondaryDatasetRef: string | null },
): string {
  if (identity.kind === "dataset") return `${identity.surface}:${descriptorSegment(identity.datasetRef)}`;
  if (identity.kind === "artifact") return `artifact:${identity.surface}:${descriptorSegment(identity.resourceKey)}`;
  return `comparison:${descriptorSegment(identity.primaryDatasetRef)}:${descriptorSegment(identity.secondaryDatasetRef)}`;
}

export function createDefaultAnalysisViewPreferences(): AnalysisViewPreferencesV2 {
  return {
    activeSurface: "dynamics",
    activeSubviews: {
      comparison: "comparison.sources",
      dispersion: "dispersion.modal",
      dynamics: "dynamics.time-traces",
      hysteresis: "hysteresis.loop",
      "resonance-fmr": "resonance.eigenmodes",
    },
    descriptorPreferences: {},
    schemaVersion: 2,
    selectedDatasetRef: null,
  };
}

export function parseAnalysisViewPreferences(raw: unknown): AnalysisViewPreferencesV2 {
  if (!isRecord(raw) || raw.schemaVersion !== 2) return createDefaultAnalysisViewPreferences();
  const descriptorPreferences: Record<string, AnalysisDescriptorPreference> = {};
  if (isRecord(raw.descriptorPreferences)) {
    for (const [id, value] of Object.entries(raw.descriptorPreferences)) {
      if (Object.keys(descriptorPreferences).length >= MAX_DESCRIPTORS) break;
      if (!validDescriptorId(id)) continue;
      const descriptor = parseDescriptor(value);
      if (descriptor) descriptorPreferences[id] = descriptor;
    }
  }
  return {
    activeSurface: migrateSurface(raw.activeSurface),
    activeSubviews: parseActiveSubviews(raw.activeSubviews),
    descriptorPreferences,
    schemaVersion: 2,
    selectedDatasetRef: validRawIdentifier(raw.selectedDatasetRef) ? raw.selectedDatasetRef : null,
  };
}

function parseActiveSubviews(raw: unknown): AnalysisActiveSubviews {
  const defaults = createDefaultAnalysisViewPreferences().activeSubviews;
  const source = isRecord(raw) ? raw : {};
  return {
    comparison: migrateSubview("comparison", source.comparison) ?? defaults.comparison,
    dispersion: migrateSubview("dispersion", source.dispersion) ?? defaults.dispersion,
    dynamics: migrateSubview("dynamics", source.dynamics) ?? defaults.dynamics,
    hysteresis: migrateSubview("hysteresis", source.hysteresis) ?? defaults.hysteresis,
    "resonance-fmr": migrateSubview(
      "resonance-fmr",
      source["resonance-fmr"] ?? source["frequency-response"] ?? source.eigenmodes,
    ) ?? defaults["resonance-fmr"],
  };
}

function migrateSubview(surface: AnalysisSurface, value: unknown): AnalysisSubview | null {
  if (typeof value !== "string") return null;
  if ((ANALYSIS_SUBVIEWS[surface] as readonly string[]).includes(value)) {
    return value as AnalysisSubview;
  }
  // Compatibility owner: Analysis subview preference parser.
  // Legacy reader version: analysis-view-preferences:v2.
  // Removal gate: remove legacy subview aliases when schema v3 ships after one
  // released v2 writer has emitted only canonical IDs and migration tests prove
  // no supported stored preference depends on the aliases.
  const legacy: Partial<Record<AnalysisSurface, Readonly<Record<string, AnalysisSubview>>>> = {
    comparison: { comparison: "comparison.sources" },
    dispersion: {
      branches: "dispersion.branches",
      "modal-dispersion": "dispersion.modal",
      "response-map": "dispersion.driven-map",
    },
    dynamics: {
      "s-k-f": "dynamics.s-k-f",
      "temporal-fft": "dynamics.temporal-fft",
      "time-traces": "dynamics.time-traces",
    },
    hysteresis: { branch: "hysteresis.branches", loop: "hysteresis.loop" },
    "resonance-fmr": {
      eigenmodes: "resonance.eigenmodes",
      "frequency-response": "resonance.frequency-response",
      "modal-driven": "resonance.modal-driven",
    },
  };
  return legacy[surface]?.[value] ?? null;
}

export function parseStoredAnalysisViewPreferences(serialized: string | null): AnalysisViewPreferencesV2 {
  if (!serialized || byteLength(serialized) > MAX_STORED_BYTES) return createDefaultAnalysisViewPreferences();
  try {
    return parseAnalysisViewPreferences(JSON.parse(serialized));
  } catch {
    return createDefaultAnalysisViewPreferences();
  }
}

export function serializeAnalysisViewPreferences(value: unknown): string | null {
  const serialized = JSON.stringify(parseAnalysisViewPreferences(value));
  return byteLength(serialized) <= MAX_STORED_BYTES ? serialized : null;
}

function parseDescriptor(raw: unknown): AnalysisDescriptorPreference | null {
  if (!isRecord(raw) || !isRecord(raw.displayUnits) || !(raw.range === null || isRecord(raw.range))) return null;
  // Compatibility owner: Analysis view preference parser.
  // Removal gate: remove comparisonSelectedSeriesKeys after one released
  // analysis-view-preferences:v2 writer uses selectedSeriesIds and migration tests
  // prove no stored descriptor still depends on the old field.
  const legacyComparisonKeys = Array.isArray(raw.comparisonSelectedSeriesKeys)
    ? raw.comparisonSelectedSeriesKeys.filter(validSeriesId).filter((value, index, all) => all.indexOf(value) === index).slice(0, MAX_SERIES)
    : undefined;
  const selectedSeriesIds = Array.isArray(raw.selectedSeriesIds)
    ? raw.selectedSeriesIds.every(validSeriesId)
      ? raw.selectedSeriesIds.filter((value, index, all) => all.indexOf(value) === index).slice(0, MAX_SERIES)
      : undefined
    : legacyComparisonKeys;
  if (!selectedSeriesIds) return null;
  const displayUnits: Record<string, string> = {};
  if (isRecord(raw.displayUnits)) {
    for (const [quantity, unit] of Object.entries(raw.displayUnits)) {
      if (Object.keys(displayUnits).length >= MAX_UNITS) break;
      if (validRawIdentifier(quantity) && typeof unit === "string" && unit.length <= 24) displayUnits[quantity] = unit;
    }
  }
  const range = isRecord(raw.range) && typeof raw.range.fromSI === "number" && Number.isFinite(raw.range.fromSI) && typeof raw.range.toSI === "number" && Number.isFinite(raw.range.toSI) && raw.range.fromSI < raw.range.toSI
    ? { fromSI: raw.range.fromSI, toSI: raw.range.toSI }
    : raw.range === null ? null : null;
  if (raw.range !== null && range === null) return null;
  return { displayUnits, range, selectedSeriesIds };
}

function descriptorSegment(value: string | null): string {
  if (value === null) return "n";
  let encoded: string;
  try {
    encoded = `v-${encodeURIComponent(value)}`;
  } catch {
    encoded = `v-invalid-${stableHash(value)}`;
  }
  if (encoded.length <= 56) return encoded;
  return `${encoded.slice(0, 47)}-${stableHash(encoded)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isSurface(value: unknown): value is AnalysisSurface {
  return typeof value === "string" && SURFACES.includes(value as AnalysisSurface);
}

function migrateSurface(value: unknown): AnalysisSurface {
  if (isSurface(value)) return value;
  if (value === "frequency-response" || value === "eigenmodes") {
    return "resonance-fmr";
  }
  if (value === "spectrum") return "dynamics";
  return "dynamics";
}

function validRawIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DESCRIPTOR_LENGTH;
}

function validDescriptorId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validSeriesId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
