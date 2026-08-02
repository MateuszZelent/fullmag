import { ANALYSIS_CHART_PREFERENCES_STORAGE_KEY } from "./analysisChartPreferences";

export type ChartRangePreference =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed"; fromSI: number; toSI: number }
  | { mode: "fullDecimated" };

export type LiveChartTargetPoints = 160 | 400 | 800 | 1600 | 3200 | 5000;

export interface LiveChartDescriptorPreferences {
  xAxisId: string;
  selectedSeriesIds: string[];
  range: ChartRangePreference;
  liveMode: "following" | "paused";
  targetPoints: LiveChartTargetPoints;
  displayUnits: Record<string, string>;
}

export interface LiveChartPreferencesV1 {
  schemaVersion: 1;
  descriptors: Record<string, LiveChartDescriptorPreferences>;
}

export const LIVE_CHART_PREFERENCES_STORAGE_KEY = "fm:live-chart-preferences:v1";
export const MAX_LIVE_CHART_DESCRIPTORS = 50;

const MAX_DESCRIPTOR_ID_LENGTH = 160;
const MAX_SELECTED_SERIES_IDS = 100;
const MAX_DISPLAY_UNITS = 40;
const MAX_DISPLAY_UNIT_LENGTH = 24;
const TARGET_POINTS: readonly LiveChartTargetPoints[] = [160, 400, 800, 1600, 3200, 5000];

function defaultDescriptorPreferences(): LiveChartDescriptorPreferences {
  return {
    displayUnits: {},
    liveMode: "following",
    range: { mode: "follow" },
    selectedSeriesIds: ["mx", "my", "mz"],
    targetPoints: 800,
    xAxisId: "step",
  };
}

export function createDefaultLiveChartPreferences(): LiveChartPreferencesV1 {
  return {
    descriptors: { magnetization: defaultDescriptorPreferences() },
    schemaVersion: 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsForbiddenPayload(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenPayload(entry, seen));
  for (const [key, entry] of Object.entries(value)) {
    if (key === "samples" || key === "series" || key === "option") return true;
    if (containsForbiddenPayload(entry, seen)) return true;
  }
  return false;
}

function parseRangePreference(value: unknown): ChartRangePreference {
  if (!isRecord(value)) return { mode: "follow" };
  switch (value.mode) {
    case "follow":
    case "fullDecimated":
      return { mode: value.mode };
    case "tailRows":
      return typeof value.rows === "number" && Number.isFinite(value.rows)
        ? { mode: "tailRows", rows: Math.max(10, Math.min(5000, Math.round(value.rows))) }
        : { mode: "follow" };
    case "tailTime":
      return typeof value.durationS === "number" && Number.isFinite(value.durationS) && value.durationS > 0
        ? { mode: "tailTime", durationS: value.durationS }
        : { mode: "follow" };
    case "fixed":
      return typeof value.fromSI === "number" && Number.isFinite(value.fromSI) &&
          typeof value.toSI === "number" && Number.isFinite(value.toSI) && value.fromSI < value.toSI
        ? { mode: "fixed", fromSI: value.fromSI, toSI: value.toSI }
        : { mode: "follow" };
    default:
      return { mode: "follow" };
  }
}

function parseTargetPoints(value: unknown): LiveChartTargetPoints {
  return TARGET_POINTS.includes(value as LiveChartTargetPoints) ? value as LiveChartTargetPoints : 800;
}

function parseSelectedSeriesIds(value: unknown): string[] {
  if (!Array.isArray(value)) return defaultDescriptorPreferences().selectedSeriesIds;
  return value
    .filter((seriesId): seriesId is string => typeof seriesId === "string")
    .filter((seriesId) => seriesId.length > 0 && seriesId.length <= MAX_DESCRIPTOR_ID_LENGTH)
    .filter((seriesId, index, ids) => ids.indexOf(seriesId) === index)
    .slice(0, MAX_SELECTED_SERIES_IDS);
}

function parseDisplayUnits(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, unit]) =>
        key.length > 0 && key.length <= MAX_DESCRIPTOR_ID_LENGTH &&
        typeof unit === "string" && unit.length <= MAX_DISPLAY_UNIT_LENGTH,
      )
      .slice(0, MAX_DISPLAY_UNITS),
  ) as Record<string, string>;
}

function parseDescriptor(value: unknown): LiveChartDescriptorPreferences {
  const defaults = defaultDescriptorPreferences();
  if (!isRecord(value)) return defaults;
  return {
    displayUnits: parseDisplayUnits(value.displayUnits),
    liveMode: value.liveMode === "paused" ? "paused" : "following",
    range: parseRangePreference(value.range),
    selectedSeriesIds: parseSelectedSeriesIds(value.selectedSeriesIds),
    targetPoints: parseTargetPoints(value.targetPoints),
    xAxisId: typeof value.xAxisId === "string" && value.xAxisId.length > 0 && value.xAxisId.length <= MAX_DESCRIPTOR_ID_LENGTH
      ? value.xAxisId
      : defaults.xAxisId,
  };
}

export function parseLiveChartPreferences(value: unknown): LiveChartPreferencesV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || containsForbiddenPayload(value)) {
    return createDefaultLiveChartPreferences();
  }
  if (!isRecord(value.descriptors)) return createDefaultLiveChartPreferences();
  const descriptors: Record<string, LiveChartDescriptorPreferences> = {};
  for (const [descriptorId, descriptor] of Object.entries(value.descriptors)) {
    if (Object.keys(descriptors).length >= MAX_LIVE_CHART_DESCRIPTORS) break;
    if (descriptorId.length === 0 || descriptorId.length > MAX_DESCRIPTOR_ID_LENGTH) continue;
    descriptors[descriptorId] = parseDescriptor(descriptor);
  }
  return { descriptors, schemaVersion: 1 };
}

export function serializeLiveChartPreferences(value: unknown): string {
  return JSON.stringify(parseLiveChartPreferences(value));
}

function storageFromBrowser(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

function legacyDescriptor(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.descriptorPreferences)) return null;
  for (const key of ["analysis:data-table:default", "analysis:charts:default", "magnetization"]) {
    const descriptor = raw.descriptorPreferences[key];
    if (isRecord(descriptor)) return descriptor;
  }
  return null;
}

function legacyMagnetizationSelection(descriptor: Record<string, unknown>): string[] | null {
  const candidate = Array.isArray(descriptor.selectedSeriesIds)
    ? descriptor.selectedSeriesIds
    : Array.isArray(descriptor.visibleYIds)
      ? descriptor.visibleYIds
      : Array.isArray(descriptor.yAxisIds)
        ? descriptor.yAxisIds
        : null;
  if (!candidate) return null;
  const selected: Array<string | null> = candidate.map((entry) => {
    if (typeof entry !== "string") return null;
    const id = entry.split(":").at(-1);
    return id === "mx" || id === "my" || id === "mz" ? id : null;
  });
  return selected.every((id): id is string => id !== null)
    ? selected.filter((id, index) => selected.indexOf(id) === index)
    : null;
}

export function migrateLegacyLiveChartPreferences(serialized: string | null): LiveChartPreferencesV1 {
  try {
    const descriptor = legacyDescriptor(serialized ? JSON.parse(serialized) : null);
    if (!descriptor || containsForbiddenPayload(descriptor)) return createDefaultLiveChartPreferences();
    const defaults = defaultDescriptorPreferences();
    const selection = legacyMagnetizationSelection(descriptor);
    return {
      descriptors: {
        magnetization: {
          displayUnits: parseDisplayUnits(descriptor.displayUnits),
          liveMode: descriptor.liveMode === "paused" ? "paused" : defaults.liveMode,
          range: parseRangePreference(descriptor.range),
          selectedSeriesIds: selection ?? defaults.selectedSeriesIds,
          targetPoints: parseTargetPoints(descriptor.targetPoints),
          xAxisId: typeof descriptor.xAxisId === "string" && descriptor.xAxisId.length > 0 && descriptor.xAxisId.length <= MAX_DESCRIPTOR_ID_LENGTH
            ? descriptor.xAxisId
            : defaults.xAxisId,
        },
      },
      schemaVersion: 1,
    };
  } catch {
    return createDefaultLiveChartPreferences();
  }
}

type PreferenceListener = () => void;

class LiveChartPreferencesStore {
  private snapshot = SERVER_SNAPSHOT;
  private initialized = false;
  private readonly listeners = new Set<PreferenceListener>();
  private storageOverride: Storage | null | undefined;

  getSnapshot = (): LiveChartPreferencesV1 => this.snapshot;
  getServerSnapshot = (): LiveChartPreferencesV1 => SERVER_SNAPSHOT;
  isHydrated = (): boolean => this.initialized;
  getServerHydrationSnapshot = (): boolean => false;

  subscribe = (listener: PreferenceListener): (() => void) => {
    this.listeners.add(listener);
    this.hydrate();
    return () => this.listeners.delete(listener);
  };

  hydrate(): void {
    if (this.initialized) return;
    const storage = this.storageOverride === undefined ? storageFromBrowser() : this.storageOverride;
    this.initialized = true;
    if (!storage) {
      this.snapshot = createDefaultLiveChartPreferences();
      this.notify();
      return;
    }
    try {
      const stored = storage.getItem(LIVE_CHART_PREFERENCES_STORAGE_KEY);
      this.snapshot = stored === null
        ? migrateLegacyLiveChartPreferences(storage.getItem(ANALYSIS_CHART_PREFERENCES_STORAGE_KEY))
        : parseLiveChartPreferences(JSON.parse(stored));
      if (stored === null) storage.setItem(LIVE_CHART_PREFERENCES_STORAGE_KEY, serializeLiveChartPreferences(this.snapshot));
      this.notify();
    } catch {
      this.snapshot = createDefaultLiveChartPreferences();
      this.notify();
    }
  }

  updateDescriptor(
    descriptorId: string,
    patch: (current: LiveChartDescriptorPreferences) => Partial<LiveChartDescriptorPreferences>,
  ): void {
    if (descriptorId.length === 0 || descriptorId.length > MAX_DESCRIPTOR_ID_LENGTH) return;
    const current = this.snapshot.descriptors[descriptorId] ?? defaultDescriptorPreferences();
    const next = parseDescriptor({ ...current, ...patch(current) });
    this.setSnapshot({
      descriptors: { ...this.snapshot.descriptors, [descriptorId]: next },
      schemaVersion: 1,
    });
  }

  reset(): void {
    const storage = this.storageOverride === undefined ? storageFromBrowser() : this.storageOverride;
    try {
      storage?.removeItem(LIVE_CHART_PREFERENCES_STORAGE_KEY);
    } catch {
      // Storage is optional and must not affect local view reset.
    }
    this.initialized = true;
    this.snapshot = SERVER_SNAPSHOT;
    this.notify();
  }

  resetForTests(storage: Storage | null = null): void {
    this.storageOverride = storage;
    this.snapshot = SERVER_SNAPSHOT;
    this.initialized = false;
    this.listeners.clear();
  }

  private setSnapshot(snapshot: LiveChartPreferencesV1): void {
    this.snapshot = parseLiveChartPreferences(snapshot);
    const storage = this.storageOverride === undefined ? storageFromBrowser() : this.storageOverride;
    try {
      storage?.setItem(LIVE_CHART_PREFERENCES_STORAGE_KEY, serializeLiveChartPreferences(this.snapshot));
    } catch {
      // Persistence failures leave the in-memory user preference intact.
    }
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

const SERVER_SNAPSHOT = createDefaultLiveChartPreferences();

export const liveChartPreferencesStore = new LiveChartPreferencesStore();

export function resetLiveChartPreferencesStoreForTests(storage: Storage | null = null): void {
  liveChartPreferencesStore.resetForTests(storage);
}
