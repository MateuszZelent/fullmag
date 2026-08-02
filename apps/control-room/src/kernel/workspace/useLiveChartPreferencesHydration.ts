"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  liveChartPreferencesStore,
  type ChartRangePreference,
  type LiveChartDescriptorPreferences,
  type LiveChartPreferencesV1,
  type LiveChartTargetPoints,
} from "./liveChartPreferences";

export function useLiveChartPreferencesHydration(descriptorId?: string): {
  prefs: LiveChartPreferencesV1;
  descriptor: LiveChartDescriptorPreferences | null;
  isHydrated: boolean;
  setDescriptorLiveMode: (id: string, liveMode: "following" | "paused") => void;
  setDescriptorRange: (id: string, range: ChartRangePreference) => void;
  setDescriptorTargetPoints: (id: string, targetPoints: LiveChartTargetPoints) => void;
  setDescriptorSelectedSeriesIds: (id: string, selectedSeriesIds: string[]) => void;
  setDescriptorXAxisId: (id: string, xAxisId: string) => void;
  reset: () => void;
} {
  const prefs = useSyncExternalStore(
    liveChartPreferencesStore.subscribe,
    liveChartPreferencesStore.getSnapshot,
    liveChartPreferencesStore.getServerSnapshot,
  );
  const isHydrated = useSyncExternalStore(
    liveChartPreferencesStore.subscribe,
    liveChartPreferencesStore.isHydrated,
    liveChartPreferencesStore.getServerHydrationSnapshot,
  );

  const updateDescriptor = useCallback(
    (id: string, patch: (current: LiveChartDescriptorPreferences) => Partial<LiveChartDescriptorPreferences>) =>
      liveChartPreferencesStore.updateDescriptor(id, patch),
    [],
  );

  return {
    prefs,
    descriptor: descriptorId ? prefs.descriptors[descriptorId] ?? null : null,
    isHydrated,
    setDescriptorLiveMode: (id, liveMode) => updateDescriptor(id, () => ({ liveMode })),
    setDescriptorRange: (id, range) => updateDescriptor(id, () => ({ range })),
    setDescriptorTargetPoints: (id, targetPoints) => updateDescriptor(id, () => ({ targetPoints })),
    setDescriptorSelectedSeriesIds: (id, selectedSeriesIds) => updateDescriptor(id, () => ({ selectedSeriesIds })),
    setDescriptorXAxisId: (id, xAxisId) => updateDescriptor(id, () => ({ xAxisId })),
    reset: () => liveChartPreferencesStore.reset(),
  };
}
