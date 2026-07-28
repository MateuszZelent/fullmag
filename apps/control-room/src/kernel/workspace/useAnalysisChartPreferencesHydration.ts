"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { AnalysisWorkbenchSurface } from "./analysisPlotsWorkspace";
import type { ChartLiveMode } from "./analysisPlotsWorkspace";
import {
  ANALYSIS_CHART_PREFERENCES_STORAGE_KEY,
  defaultAnalysisChartPreferences,
  getOrCreateDescriptorPreferences,
  readAnalysisChartPreferencesFromStorage,
  writeAnalysisChartPreferencesToStorage,
  type AnalysisChartPreferencesV1,
  type ChartRangePreference,
  type ChartTargetPoints,
  type DescriptorPreferences,
} from "./analysisChartPreferences";

// ===== Store =====

let _prefs: AnalysisChartPreferencesV1 = defaultAnalysisChartPreferences();
let _initialized = false;
const _subscribers = new Set<() => void>();

function getPrefs(): AnalysisChartPreferencesV1 {
  if (!_initialized && typeof window !== "undefined") {
    _prefs = readAnalysisChartPreferencesFromStorage();
    _initialized = true;
  }
  return _prefs;
}

const SERVER_SNAPSHOT: AnalysisChartPreferencesV1 = defaultAnalysisChartPreferences();

function getServerSnapshot(): AnalysisChartPreferencesV1 {
  return SERVER_SNAPSHOT;
}

function updatePrefs(update: (prev: AnalysisChartPreferencesV1) => AnalysisChartPreferencesV1): void {
  const next = update(_prefs);
  _prefs = next;
  writeAnalysisChartPreferencesToStorage(next);
  _subscribers.forEach((fn) => fn());
}

let _storageListenerAttached = false;
function ensureStorageListener(): void {
  if (_storageListenerAttached || typeof window === "undefined") return;
  _storageListenerAttached = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === ANALYSIS_CHART_PREFERENCES_STORAGE_KEY) {
      _prefs = readAnalysisChartPreferencesFromStorage();
      _initialized = true;
      _subscribers.forEach((f) => f());
    }
  });
}

function subscribe(fn: () => void): () => void {
  _subscribers.add(fn);
  ensureStorageListener();
  return () => {
    _subscribers.delete(fn);
  };
}

// ===== Hook =====

/**
 * useAnalysisChartPreferencesHydration — SSR-safe hook for reading and writing
 * Analysis chart preferences.
 *
 * - First server render: returns defaults (prevents hydration mismatch).
 * - Client hydration: reads from localStorage on the first `subscribe` call.
 * - Cross-tab sync: subscribes to `storage` events.
 * - `descriptorId`: pass the resource key / descriptor identity of the active chart.
 *   Pass `undefined` to operate only on the global activeSurface preference.
 */
export function useAnalysisChartPreferencesHydration(descriptorId?: string): {
  prefs: AnalysisChartPreferencesV1;
  descriptor: DescriptorPreferences | null;
  /** True only after the client snapshot has read persisted preferences. */
  isHydrated: boolean;
  setActiveSurface: (surface: AnalysisWorkbenchSurface) => void;
  setDescriptorLiveMode: (id: string, liveMode: ChartLiveMode) => void;
  setDescriptorRange: (id: string, range: ChartRangePreference) => void;
  setDescriptorTargetPoints: (id: string, targetPoints: ChartTargetPoints) => void;
  setDescriptorHiddenSeries: (id: string, hiddenSeriesIds: string[]) => void;
  setDescriptorSoloSeries: (id: string, soloSeriesId: string | null) => void;
  setDescriptorYAxisIds: (id: string, yAxisIds: string[]) => void;
  setDescriptorXAxisId: (id: string, xAxisId: string) => void;
  resetDescriptor: (id: string) => void;
} {
  const prefs = useSyncExternalStore(subscribe, getPrefs, getServerSnapshot);

  const descriptor = descriptorId
    ? (prefs.descriptorPreferences[descriptorId] ?? null)
    : null;

  const setActiveSurface = useCallback((surface: AnalysisWorkbenchSurface) => {
    updatePrefs((prev) => ({ ...prev, activeSurface: surface }));
  }, []);

  const updateDescriptor = useCallback(
    (id: string, patch: (prev: DescriptorPreferences) => Partial<DescriptorPreferences>) => {
      updatePrefs((prev) => {
        const { prefs: p, descriptor: d } = getOrCreateDescriptorPreferences(prev, id);
        return {
          ...p,
          descriptorPreferences: {
            ...p.descriptorPreferences,
            [id]: { ...d, ...patch(d) },
          },
        };
      });
    },
    [],
  );

  const setDescriptorLiveMode = useCallback(
    (id: string, liveMode: ChartLiveMode) =>
      updateDescriptor(id, () => ({ liveMode })),
    [updateDescriptor],
  );

  const setDescriptorRange = useCallback(
    (id: string, range: ChartRangePreference) =>
      updateDescriptor(id, () => ({ range })),
    [updateDescriptor],
  );

  const setDescriptorTargetPoints = useCallback(
    (id: string, targetPoints: ChartTargetPoints) =>
      updateDescriptor(id, () => ({ targetPoints })),
    [updateDescriptor],
  );

  const setDescriptorHiddenSeries = useCallback(
    (id: string, hiddenSeriesIds: string[]) =>
      updateDescriptor(id, () => ({ hiddenSeriesIds })),
    [updateDescriptor],
  );

  const setDescriptorSoloSeries = useCallback(
    (id: string, soloSeriesId: string | null) =>
      updateDescriptor(id, () => ({ soloSeriesId })),
    [updateDescriptor],
  );

  const setDescriptorYAxisIds = useCallback(
    (id: string, yAxisIds: string[]) =>
      updateDescriptor(id, () => ({ yAxisIds })),
    [updateDescriptor],
  );

  const setDescriptorXAxisId = useCallback(
    (id: string, xAxisId: string) =>
      updateDescriptor(id, () => ({ xAxisId })),
    [updateDescriptor],
  );

  const resetDescriptor = useCallback(
    (id: string) => {
      updatePrefs((prev) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _r, ...rest } = prev.descriptorPreferences;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _l, ...lruRest } = prev._lruAccessAt;
        return { ...prev, descriptorPreferences: rest, _lruAccessAt: lruRest };
      });
    },
    [],
  );

  return {
    prefs,
    descriptor,
    isHydrated: _initialized,
    setActiveSurface,
    setDescriptorLiveMode,
    setDescriptorRange,
    setDescriptorTargetPoints,
    setDescriptorHiddenSeries,
    setDescriptorSoloSeries,
    setDescriptorYAxisIds,
    setDescriptorXAxisId,
    resetDescriptor,
  };
}
