export type AnalysisSurface =
  | "dynamics"
  | "spectrum"
  | "frequency-response"
  | "eigenmodes"
  | "dispersion"
  | "hysteresis"
  | "comparison";

export interface AnalysisDescriptorPreference {
  selectedSeriesIds: string[];
  displayUnits: Record<string, string>;
  range: { fromSI: number; toSI: number } | null;
}

export interface AnalysisViewPreferencesV2 {
  schemaVersion: 2;
  activeSurface: AnalysisSurface;
  selectedDatasetRef: string | null;
  descriptorPreferences: Record<string, AnalysisDescriptorPreference>;
}

export const ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY = "fm:analysis-view-preferences:v2";
const SURFACES: readonly AnalysisSurface[] = ["dynamics", "spectrum", "frequency-response", "eigenmodes", "dispersion", "hysteresis", "comparison"];
const MAX_DESCRIPTORS = 50;
const MAX_DESCRIPTOR_LENGTH = 160;
const MAX_SERIES = 100;
const MAX_UNITS = 40;
const MAX_STORED_BYTES = 256 * 1024;

export function createDefaultAnalysisViewPreferences(): AnalysisViewPreferencesV2 {
  return { activeSurface: "dynamics", descriptorPreferences: {}, schemaVersion: 2, selectedDatasetRef: null };
}

export function parseAnalysisViewPreferences(raw: unknown): AnalysisViewPreferencesV2 {
  if (!isRecord(raw) || raw.schemaVersion !== 2) return createDefaultAnalysisViewPreferences();
  const descriptorPreferences: Record<string, AnalysisDescriptorPreference> = {};
  if (isRecord(raw.descriptorPreferences)) {
    for (const [id, value] of Object.entries(raw.descriptorPreferences)) {
      if (Object.keys(descriptorPreferences).length >= MAX_DESCRIPTORS) break;
      if (!validIdentifier(id)) continue;
      descriptorPreferences[id] = parseDescriptor(value);
    }
  }
  return {
    activeSurface: isSurface(raw.activeSurface) ? raw.activeSurface : "dynamics",
    descriptorPreferences,
    schemaVersion: 2,
    selectedDatasetRef: validIdentifier(raw.selectedDatasetRef) ? raw.selectedDatasetRef : null,
  };
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

function parseDescriptor(raw: unknown): AnalysisDescriptorPreference {
  if (!isRecord(raw)) return { displayUnits: {}, range: null, selectedSeriesIds: [] };
  const selectedSeriesIds = Array.isArray(raw.selectedSeriesIds)
    ? raw.selectedSeriesIds.filter(validIdentifier).filter((value, index, all) => all.indexOf(value) === index).slice(0, MAX_SERIES)
    : [];
  const displayUnits: Record<string, string> = {};
  if (isRecord(raw.displayUnits)) {
    for (const [quantity, unit] of Object.entries(raw.displayUnits)) {
      if (Object.keys(displayUnits).length >= MAX_UNITS) break;
      if (validIdentifier(quantity) && typeof unit === "string" && unit.length <= 24) displayUnits[quantity] = unit;
    }
  }
  const range = isRecord(raw.range) && typeof raw.range.fromSI === "number" && Number.isFinite(raw.range.fromSI) && typeof raw.range.toSI === "number" && Number.isFinite(raw.range.toSI) && raw.range.fromSI < raw.range.toSI
    ? { fromSI: raw.range.fromSI, toSI: raw.range.toSI }
    : null;
  return { displayUnits, range, selectedSeriesIds };
}

function isSurface(value: unknown): value is AnalysisSurface {
  return typeof value === "string" && SURFACES.includes(value as AnalysisSurface);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DESCRIPTOR_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
