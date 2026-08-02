/**
 * analysisChartPreferences.ts — Versioned, SSR-safe preferences model for the
 * Analysis workbench chart view.
 *
 * Contract:
 * - schemaVersion 1 is the current format.
 * - All values are validated, clamped and repaired on read.
 * - No payloads (Float64Array, rows, points) are stored here.
 * - Session-specific state (cursor row ids, selection) are NOT persisted.
 * - LRU: at most MAX_DESCRIPTORS descriptor entries; oldest-access removed first.
 * - SSR-safe: never read localStorage on the server; use getServerSnapshot().
 * - On migration failure: silent reset to defaults.
 */

import type { AnalysisWorkbenchSurface, ChartLiveMode } from "./analysisPlotsWorkspace";

export type ChartRangePreferenceMode =
  | "follow"
  | "tailRows"
  | "tailTime"
  | "fixed"
  | "fullDecimated";

export type ChartRangePreference =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed"; fromSI: number; toSI: number }
  | { mode: "fullDecimated" };

/**
 * Allowed target point counts. Server decimation maps to these buckets.
 * 5000 is the absolute maximum; 1600 is the default.
 */
export type ChartTargetPoints = 160 | 400 | 800 | 1600 | 3200 | 5000;

export const DEFAULT_TARGET_POINTS: ChartTargetPoints = 1600;
export const TARGET_POINTS_OPTIONS: readonly ChartTargetPoints[] = [
  160, 400, 800, 1600, 3200, 5000,
];

export const MAX_DESCRIPTORS = 50;
const MAX_DESCRIPTOR_ID_LENGTH = 160;
const MAX_DISPLAY_UNITS = 40;
const MAX_DISPLAY_UNIT_LENGTH = 24;

export interface DescriptorPreferences {
  /** Units display overrides: quantity ID → display unit symbol */
  displayUnits: Record<string, string>;
  /** Series IDs selected by the user */
  selectedSeriesIds: string[];
  liveMode: ChartLiveMode;
  range: ChartRangePreference;
  /** Server decimation target — one of the allowed bucket values */
  targetPoints: ChartTargetPoints;
  xAxisId: string;
}

export interface AnalysisChartPreferencesV1 {
  schemaVersion: 1;
  activeSurface: AnalysisWorkbenchSurface;
  /** Keyed by descriptor ID (resource key or chart descriptor) */
  descriptorPreferences: Record<string, DescriptorPreferences>;
  /** LRU access timestamps for descriptor eviction */
  _lruAccessAt: Record<string, number>;
}

/** Converts compact Inspector range state into the persisted SI contract. */
export function chartRangePreferenceFromWorkspace(
  rangeMode:
    | { mode: "follow" }
    | { mode: "tailRows"; rows: number }
    | { mode: "tailTime"; durationS: number }
    | { mode: "fixed" }
    | { mode: "fullDecimated" },
  range: { fromValue: number; toValue: number } | null,
): ChartRangePreference {
  if (rangeMode.mode === "fixed") {
    return range
      ? { fromSI: range.fromValue, mode: "fixed", toSI: range.toValue }
      : { mode: "follow" };
  }
  return rangeMode;
}

// ===== Defaults =====

export function defaultDescriptorPreferences(descriptorId?: string): DescriptorPreferences {
  return {
    displayUnits: {},
    selectedSeriesIds: defaultSelectedSeriesIds(descriptorId),
    liveMode: "following",
    range: { mode: "follow" },
    targetPoints: DEFAULT_TARGET_POINTS,
    xAxisId: "step",
  };
}

export function defaultAnalysisChartPreferences(): AnalysisChartPreferencesV1 {
  return {
    schemaVersion: 1,
    activeSurface: "overview",
    descriptorPreferences: {},
    _lruAccessAt: {},
  };
}

// ===== Validation and clamping =====

export function isValidTargetPoints(value: unknown): value is ChartTargetPoints {
  return TARGET_POINTS_OPTIONS.includes(value as ChartTargetPoints);
}

export function clampTargetPoints(value: unknown): ChartTargetPoints {
  if (isValidTargetPoints(value)) return value;
  // Find the closest valid bucket
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return TARGET_POINTS_OPTIONS.reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
    );
  }
  return DEFAULT_TARGET_POINTS;
}

export function clampRangePreference(value: unknown): ChartRangePreference {
  if (!value || typeof value !== "object") return { mode: "follow" };
  const v = value as Record<string, unknown>;
  switch (v["mode"]) {
    case "follow":
    case "fullDecimated":
      return { mode: v["mode"] as "follow" | "fullDecimated" };
    case "tailRows": {
      const rows = typeof v["rows"] === "number" ? Math.max(10, Math.min(5000, Math.round(v["rows"]))) : 400;
      return { mode: "tailRows", rows };
    }
    case "tailTime": {
      const durationS = typeof v["durationS"] === "number" && v["durationS"] > 0
        ? v["durationS"]
        : 100e-9; // 100 ns default
      return { mode: "tailTime", durationS };
    }
    case "fixed": {
      const fromSI = typeof v["fromSI"] === "number" && Number.isFinite(v["fromSI"]) ? v["fromSI"] : 0;
      const toSI = typeof v["toSI"] === "number" && Number.isFinite(v["toSI"]) ? v["toSI"] : 1;
      if (fromSI >= toSI) return { mode: "follow" };
      return { mode: "fixed", fromSI, toSI };
    }
    default:
      return { mode: "follow" };
  }
}

export function validateDescriptorPreferences(
  raw: unknown,
  descriptorId?: string,
): DescriptorPreferences {
  const defaults = defaultDescriptorPreferences(descriptorId);
  if (!raw || typeof raw !== "object") return defaults;
  const v = raw as Record<string, unknown>;
  return {
    displayUnits: validatedDisplayUnits(v["displayUnits"]),
    selectedSeriesIds: Array.isArray(v["selectedSeriesIds"])
      ? normalizeSelectedSeriesIds(v["selectedSeriesIds"])
      : legacySelectedSeriesIds(v, descriptorId, defaults),
    liveMode:
      v["liveMode"] === "following" || v["liveMode"] === "paused"
        ? v["liveMode"]
        : "following",
    range: clampRangePreference(v["range"]),
    targetPoints: clampTargetPoints(v["targetPoints"]),
    xAxisId: typeof v["xAxisId"] === "string" ? v["xAxisId"].slice(0, MAX_DESCRIPTOR_ID_LENGTH) : "step",
  };
}

export function validateAnalysisChartPreferences(
  raw: unknown,
): AnalysisChartPreferencesV1 {
  const defaults = defaultAnalysisChartPreferences();
  if (!raw || typeof raw !== "object") return defaults;
  const v = raw as Record<string, unknown>;
  if (v["schemaVersion"] !== 1) return defaults;
  const rawDescriptors = v["descriptorPreferences"];
  const rawLru = v["_lruAccessAt"];
  const descriptorPreferences: Record<string, DescriptorPreferences> = {};
  const lruAccessAt: Record<string, number> = {};
  if (rawDescriptors && typeof rawDescriptors === "object" && !Array.isArray(rawDescriptors)) {
    for (const [key, value] of Object.entries(rawDescriptors as Record<string, unknown>)) {
      if (key.length === 0 || key.length > MAX_DESCRIPTOR_ID_LENGTH) continue;
      descriptorPreferences[key] = validateDescriptorPreferences(value, key);
      const access = (rawLru as Record<string, unknown>)?.[key];
      lruAccessAt[key] =
        typeof access === "number" && Number.isFinite(access) && access >= 0
          ? access
          : Date.now();
    }
  }
  // Enforce LRU limit
  const trimmedKeys = lruEvict(Object.keys(descriptorPreferences), lruAccessAt, MAX_DESCRIPTORS);
  const trimmedDescriptors: Record<string, DescriptorPreferences> = {};
  const trimmedLru: Record<string, number> = {};
  for (const key of trimmedKeys) {
    trimmedDescriptors[key] = descriptorPreferences[key]!;
    trimmedLru[key] = lruAccessAt[key] ?? Date.now();
  }
  return {
    schemaVersion: 1,
    activeSurface: isValidSurface(v["activeSurface"])
      ? v["activeSurface"]
      : "overview",
    descriptorPreferences: trimmedDescriptors,
    _lruAccessAt: trimmedLru,
  };
}

function legacySelectedSeriesIds(
  raw: Record<string, unknown>,
  descriptorId: string | undefined,
  defaults: DescriptorPreferences,
): string[] {
  if (!Array.isArray(raw["yAxisIds"])) return defaults.selectedSeriesIds;
  const legacy = normalizeSelectedSeriesIds(raw["yAxisIds"]);
  if (
    (descriptorId === "analysis:solver-energy-history" || descriptorId === "analysis:frequency-domain") &&
    legacy.length === 4 &&
    legacy.every((id, index) => id === ["mx", "my", "mz", "e_total"][index])
  ) return defaults.selectedSeriesIds;
  const xAxisId = typeof raw["xAxisId"] === "string" ? raw["xAxisId"] : "step";
  return normalizeSelectedSeriesIds(legacy.flatMap((id) => {
    if (descriptorId === "analysis:solver-energy-history") {
      return [`simulation.solver.energies:${id}`];
    }
    if (descriptorId === "analysis:frequency-domain") {
      return [id.startsWith("analysis.frequency-domain:") ? id : `analysis.frequency-domain:${id}`];
    }
    return [`data.table:default:${xAxisId}:${id}`];
  }));
}

function normalizeSelectedSeriesIds(value: readonly unknown[]): string[] {
  return value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.slice(0, MAX_DESCRIPTOR_ID_LENGTH))
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .slice(0, 100);
}

// ===== LRU helpers =====

function lruEvict(
  keys: string[],
  accessAt: Record<string, number>,
  maxCount: number,
): string[] {
  if (keys.length <= maxCount) return keys;
  return keys
    .slice()
    .sort((a, b) => (accessAt[b] ?? 0) - (accessAt[a] ?? 0))
    .slice(0, maxCount);
}

function isValidSurface(value: unknown): value is AnalysisWorkbenchSurface {
  return (
    value === "overview" ||
    value === "energy" ||
    value === "dynamics" ||
    value === "convergence" ||
    value === "frequency"
  );
}

// ===== Storage key =====

export const ANALYSIS_CHART_PREFERENCES_STORAGE_KEY = "fm:analysis-chart-preferences:v1";

/**
 * Safely parse preferences from localStorage.
 * Returns defaults on parse/validation failure.
 * Never throws.
 */
function getStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function readAnalysisChartPreferencesFromStorage(): AnalysisChartPreferencesV1 {
  try {
    const storage = getStorage();
    if (!storage) return defaultAnalysisChartPreferences();
    const raw = storage.getItem(ANALYSIS_CHART_PREFERENCES_STORAGE_KEY);
    if (!raw) return defaultAnalysisChartPreferences();
    return validateAnalysisChartPreferences(JSON.parse(raw));
  } catch {
    return defaultAnalysisChartPreferences();
  }
}

/**
 * Safely write preferences to localStorage.
 * Drops oldest LRU entries if the JSON exceeds 256KB.
 * Never throws.
 */
export function writeAnalysisChartPreferencesToStorage(
  prefs: AnalysisChartPreferencesV1,
): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    const json = JSON.stringify(prefs);
    let candidate = prefs;
    let candidateJson = json;
    while (candidateJson.length > 256 * 1024 && Object.keys(candidate.descriptorPreferences).length > 1) {
      const keys = Object.keys(candidate.descriptorPreferences);
      const kept = lruEvict(keys, candidate._lruAccessAt, Math.max(1, Math.floor(keys.length / 2)));
      candidate = {
        ...candidate,
        descriptorPreferences: Object.fromEntries(kept.map((k) => [k, candidate.descriptorPreferences[k]!])),
        _lruAccessAt: Object.fromEntries(kept.map((k) => [k, candidate._lruAccessAt[k] ?? Date.now()])),
      };
      candidateJson = JSON.stringify(candidate);
    }
    if (candidateJson.length <= 256 * 1024) {
      storage.setItem(ANALYSIS_CHART_PREFERENCES_STORAGE_KEY, candidateJson);
    }
  } catch {
    // Ignore storage quota or access errors
  }
}

/**
 * Get or create descriptor preferences with LRU update.
 */
export function getOrCreateDescriptorPreferences(
  prefs: AnalysisChartPreferencesV1,
  descriptorId: string,
): {
  prefs: AnalysisChartPreferencesV1;
  descriptor: DescriptorPreferences;
} {
  const existing = prefs.descriptorPreferences[descriptorId];
  const descriptor = existing ?? defaultDescriptorPreferences(descriptorId);
  const keys = [...Object.keys(prefs.descriptorPreferences), descriptorId];
  const lruAccessAt = { ...prefs._lruAccessAt, [descriptorId]: Date.now() };
  const trimmedKeys = lruEvict(keys, lruAccessAt, MAX_DESCRIPTORS);
  const descriptorPreferences = Object.fromEntries(
    trimmedKeys.map((k) => [
      k,
      k === descriptorId
        ? descriptor
        : (prefs.descriptorPreferences[k] ?? defaultDescriptorPreferences(k)),
    ]),
  );
  return {
    prefs: {
      ...prefs,
      descriptorPreferences,
      _lruAccessAt: Object.fromEntries(trimmedKeys.map((key) => [key, lruAccessAt[key] ?? Date.now()])),
    },
    descriptor,
  };
}

function defaultSelectedSeriesIds(descriptorId?: string): string[] {
  if (descriptorId === "analysis:solver-energy-history") {
    return [
      "simulation.solver.energies:exchange",
      "simulation.solver.energies:demag",
      "simulation.solver.energies:zeeman",
      "simulation.solver.energies:anisotropy",
      "simulation.solver.energies:dmi",
      "simulation.solver.energies:total",
    ];
  }
  if (descriptorId === "analysis:frequency-domain") return [];
  return [
    "data.table:default:step:mx",
    "data.table:default:step:my",
    "data.table:default:step:mz",
    "data.table:default:step:e_total",
  ];
}

function validatedDisplayUnits(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, unit]) =>
        key.length <= MAX_DESCRIPTOR_ID_LENGTH &&
        typeof unit === "string" &&
        unit.length > 0 &&
        unit.length <= MAX_DISPLAY_UNIT_LENGTH,
      )
      .slice(0, MAX_DISPLAY_UNITS)
      .map(([key, unit]) => [key.slice(0, MAX_DESCRIPTOR_ID_LENGTH), unit as string]),
  );
}
