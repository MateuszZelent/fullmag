"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY,
  createDefaultAnalysisViewPreferences,
  parseAnalysisViewPreferences,
  parseStoredAnalysisViewPreferences,
  serializeAnalysisViewPreferences,
  ANALYSIS_SUBVIEWS,
  type AnalysisSubview,
  type AnalysisDescriptorPreference,
  type AnalysisSurface,
  type AnalysisViewPreferencesV2,
} from "./analysisViewPreferences";

interface Snapshot { preferences: AnalysisViewPreferencesV2; isHydrated: boolean; }
const SERVER: Snapshot = { isHydrated: false, preferences: createDefaultAnalysisViewPreferences() };
let snapshot = SERVER;
const listeners = new Set<() => void>();
let hydrated = false;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  snapshot = { isHydrated: true, preferences: parseStoredAnalysisViewPreferences(storage()?.getItem(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY) ?? null) };
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrate();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY) return;
    snapshot = { isHydrated: true, preferences: parseStoredAnalysisViewPreferences(event.newValue) };
    listeners.forEach((subscriber) => subscriber());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
function update(mutator: (current: AnalysisViewPreferencesV2) => AnalysisViewPreferencesV2): void {
  const preferences = parseAnalysisViewPreferences(mutator(snapshot.preferences));
  snapshot = { isHydrated: hydrated, preferences };
  const serialized = serializeAnalysisViewPreferences(preferences);
  try { if (serialized) storage()?.setItem(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY, serialized); } catch { /* browser persistence is best effort */ }
  listeners.forEach((listener) => listener());
}

export function useAnalysisViewPreferencesHydration() {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => SERVER);
  const setActiveSurface = useCallback((activeSurface: AnalysisSurface) => update((preferences) => ({ ...preferences, activeSurface })), []);
  const setActiveSubview = useCallback((surface: AnalysisSurface, activeSubview: AnalysisSubview) => update((preferences) => (
    (ANALYSIS_SUBVIEWS[surface] as readonly AnalysisSubview[]).includes(activeSubview)
      ? { ...preferences, activeSubviews: { ...preferences.activeSubviews, [surface]: activeSubview } }
      : preferences
  )), []);
  const setSelectedDatasetRef = useCallback((selectedDatasetRef: string | null) => update((preferences) => ({ ...preferences, selectedDatasetRef })), []);
  const setDescriptorPreference = useCallback((descriptorId: string, descriptor: AnalysisDescriptorPreference) => update((preferences) => ({ ...preferences, descriptorPreferences: { ...preferences.descriptorPreferences, [descriptorId]: descriptor } })), []);
  return { ...state, setActiveSubview, setActiveSurface, setDescriptorPreference, setSelectedDatasetRef };
}
