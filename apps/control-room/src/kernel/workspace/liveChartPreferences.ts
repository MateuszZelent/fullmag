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
/** Matches the compact Analysis preference storage contract. */
export const MAX_NEW_STORED_BYTES = 256 * 1024;
export const MAX_LEGACY_STORED_BYTES = MAX_NEW_STORED_BYTES;

const MAX_DESCRIPTOR_ID_LENGTH = 160;
const MAX_SELECTED_SERIES_IDS = 100;
const MAX_DISPLAY_UNITS = 40;
const MAX_DISPLAY_UNIT_LENGTH = 24;
const MAX_RAW_SELECTED_SERIES_IDS = 256;
const MAX_DESCRIPTOR_FIELDS = 128;
const TARGET_POINTS: readonly LiveChartTargetPoints[] = [160, 400, 800, 1600, 3200, 5000];

function storedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fitsStoredBytes(value: string, maximum: number): boolean {
  return storedByteLength(value) <= maximum;
}

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
  if (Array.isArray(value)) {
    if (value.length > MAX_RAW_SELECTED_SERIES_IDS) return true;
    for (let index = 0; index < value.length; index += 1) {
      if (containsForbiddenPayload(value[index], seen)) return true;
    }
    return false;
  }
  let fieldCount = 0;
  for (const key in value) {
    fieldCount += 1;
    if (fieldCount > MAX_DESCRIPTOR_FIELDS) return true;
    const entry = (value as Record<string, unknown>)[key];
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
  if (value.length > MAX_RAW_SELECTED_SERIES_IDS) return defaultDescriptorPreferences().selectedSeriesIds;
  const selected: string[] = [];
  for (let index = 0; index < value.length && selected.length < MAX_SELECTED_SERIES_IDS; index += 1) {
    const seriesId = value[index];
    if (
      typeof seriesId === "string" && seriesId.length > 0 &&
      seriesId.length <= MAX_DESCRIPTOR_ID_LENGTH && !selected.includes(seriesId)
    ) selected.push(seriesId);
  }
  return selected;
}

function parseDisplayUnits(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const displayUnits: Record<string, string> = {};
  let count = 0;
  for (const key in value) {
    count += 1;
    if (count > MAX_DISPLAY_UNITS) return {};
    const unit = value[key];
    if (
      key.length > 0 && key.length <= MAX_DESCRIPTOR_ID_LENGTH &&
      typeof unit === "string" && unit.length <= MAX_DISPLAY_UNIT_LENGTH
    ) displayUnits[key] = unit;
  }
  return displayUnits;
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
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return createDefaultLiveChartPreferences();
  }
  if (!isRecord(value.descriptors)) return createDefaultLiveChartPreferences();
  const descriptors: Record<string, LiveChartDescriptorPreferences> = {};
  let descriptorCount = 0;
  for (const descriptorId in value.descriptors) {
    descriptorCount += 1;
    if (descriptorCount > MAX_LIVE_CHART_DESCRIPTORS) break;
    if (descriptorId.length === 0 || descriptorId.length > MAX_DESCRIPTOR_ID_LENGTH) continue;
    const descriptor = value.descriptors[descriptorId];
    if (containsForbiddenPayload(descriptor)) return createDefaultLiveChartPreferences();
    descriptors[descriptorId] = parseDescriptor(descriptor);
  }
  return { descriptors, schemaVersion: 1 };
}

export function parseStoredLiveChartPreferences(serialized: string | null): LiveChartPreferencesV1 {
  if (!serialized || !fitsStoredBytes(serialized, MAX_NEW_STORED_BYTES)) {
    return createDefaultLiveChartPreferences();
  }
  try {
    return parseLiveChartPreferences(JSON.parse(serialized));
  } catch {
    return createDefaultLiveChartPreferences();
  }
}

export function serializeLiveChartPreferences(value: unknown): string | null {
  const serialized = JSON.stringify(parseLiveChartPreferences(value));
  return fitsStoredBytes(serialized, MAX_NEW_STORED_BYTES) ? serialized : null;
}

function storageFromBrowser(): Storage | null {
  if (typeof window !== "undefined") {
    try {
      return window.localStorage ?? null;
    } catch {
      return null;
    }
  }
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function readStorage(storage: Storage, key: string): { available: boolean; value: string | null } {
  try {
    return { available: true, value: storage.getItem(key) };
  } catch {
    return { available: false, value: null };
  }
}

function writeStorage(storage: Storage | null, key: string, value: string): void {
  if (!fitsStoredBytes(value, MAX_NEW_STORED_BYTES)) return;
  try {
    storage?.setItem(key, value);
  } catch {
    // Persistence is best-effort; in-memory preferences remain authoritative.
  }
}

function removeStorage(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Persistence is best-effort; reset still updates the in-memory view.
  }
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
    if (!serialized || !fitsStoredBytes(serialized, MAX_LEGACY_STORED_BYTES)) return createDefaultLiveChartPreferences();
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

export interface LiveChartPreferencesHydrationSnapshot {
  preferences: LiveChartPreferencesV1;
  isHydrated: boolean;
}

class LiveChartPreferencesStore {
  private hydrationSnapshot = SERVER_HYDRATION_SNAPSHOT;
  private readonly listeners = new Set<PreferenceListener>();
  private storageOverride: Storage | null | undefined;

  getSnapshot = (): LiveChartPreferencesV1 => this.hydrationSnapshot.preferences;
  getServerSnapshot = (): LiveChartPreferencesV1 => SERVER_SNAPSHOT;
  getHydrationSnapshot = (): LiveChartPreferencesHydrationSnapshot => this.hydrationSnapshot;
  getServerHydrationSnapshot = (): LiveChartPreferencesHydrationSnapshot => SERVER_HYDRATION_SNAPSHOT;
  isHydrated = (): boolean => this.hydrationSnapshot.isHydrated;

  subscribe = (listener: PreferenceListener): (() => void) => {
    this.listeners.add(listener);
    this.hydrate();
    return () => this.listeners.delete(listener);
  };

  hydrate(): void {
    if (this.hydrationSnapshot.isHydrated) return;
    const storage = this.storageOverride === undefined ? storageFromBrowser() : this.storageOverride;
    let preferences = createDefaultLiveChartPreferences();
    if (storage) {
      const stored = readStorage(storage, LIVE_CHART_PREFERENCES_STORAGE_KEY);
      if (stored.available && stored.value === null) {
        const legacy = readStorage(storage, ANALYSIS_CHART_PREFERENCES_STORAGE_KEY);
        preferences = migrateLegacyLiveChartPreferences(legacy.available ? legacy.value : null);
        const serialized = serializeLiveChartPreferences(preferences);
        if (serialized) writeStorage(storage, LIVE_CHART_PREFERENCES_STORAGE_KEY, serialized);
      } else if (stored.available) {
        preferences = parseStoredLiveChartPreferences(stored.value);
      }
    }
    this.hydrationSnapshot = { isHydrated: true, preferences };
    this.notify();
  }

  updateDescriptor(
    descriptorId: string,
    patch: (current: LiveChartDescriptorPreferences) => Partial<LiveChartDescriptorPreferences>,
  ): void {
    if (descriptorId.length === 0 || descriptorId.length > MAX_DESCRIPTOR_ID_LENGTH) return;
    const current = this.hydrationSnapshot.preferences.descriptors[descriptorId] ?? defaultDescriptorPreferences();
    const next = parseDescriptor({ ...current, ...patch(current) });
    this.setSnapshot({
      descriptors: { ...this.hydrationSnapshot.preferences.descriptors, [descriptorId]: next },
      schemaVersion: 1,
    });
  }

  reset(): void {
    const storage = this.storageOverride === undefined ? storageFromBrowser() : this.storageOverride;
    removeStorage(storage, LIVE_CHART_PREFERENCES_STORAGE_KEY);
    this.hydrationSnapshot = { isHydrated: true, preferences: SERVER_SNAPSHOT };
    this.notify();
  }

  resetForTests(storage?: Storage | null): void {
    this.storageOverride = storage;
    this.hydrationSnapshot = SERVER_HYDRATION_SNAPSHOT;
    this.listeners.clear();
  }

  private setSnapshot(snapshot: LiveChartPreferencesV1): void {
    const preferences = parseLiveChartPreferences(snapshot);
    const serialized = serializeLiveChartPreferences(preferences);
    if (!serialized) return;
    this.hydrationSnapshot = {
      isHydrated: this.hydrationSnapshot.isHydrated,
      preferences,
    };
    const storage = this.storageOverride === undefined ? storageFromBrowser() : this.storageOverride;
    writeStorage(storage, LIVE_CHART_PREFERENCES_STORAGE_KEY, serialized);
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

const SERVER_SNAPSHOT = createDefaultLiveChartPreferences();
const SERVER_HYDRATION_SNAPSHOT: LiveChartPreferencesHydrationSnapshot = {
  isHydrated: false,
  preferences: SERVER_SNAPSHOT,
};

export const liveChartPreferencesStore = new LiveChartPreferencesStore();

export function resetLiveChartPreferencesStoreForTests(storage?: Storage | null): void {
  liveChartPreferencesStore.resetForTests(storage);
}
