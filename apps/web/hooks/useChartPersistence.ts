"use client";

/**
 * useChartPersistence — persists ChartState to localStorage so chart
 * configuration survives page refreshes and tab switches.
 *
 * Falls back to the default "energy" preset if nothing is saved.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { ChartState } from "../components/plots/chartTypes";
import { DEFAULT_CHART_STATE } from "../components/plots/chartTypes";

const STORAGE_KEY = "fullmag:charts:state";
const DEBOUNCE_MS = 500;

function readFromStorage(): ChartState {
  if (typeof window === "undefined") return DEFAULT_CHART_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHART_STATE;
    const parsed = JSON.parse(raw) as Partial<ChartState>;
    return {
      xColumn:
        typeof parsed.xColumn === "string" ? parsed.xColumn : DEFAULT_CHART_STATE.xColumn,
      activeSeriesKeys: Array.isArray(parsed.activeSeriesKeys)
        ? parsed.activeSeriesKeys.filter(
            (key): key is string => typeof key === "string",
          )
        : DEFAULT_CHART_STATE.activeSeriesKeys,
      activePreset:
        typeof parsed.activePreset === "string"
          ? (parsed.activePreset as ChartState["activePreset"])
          : null,
      selectedDomain:
        typeof parsed.selectedDomain === "string"
          ? parsed.selectedDomain
          : null,
    };
  } catch {
    return DEFAULT_CHART_STATE;
  }
}

function writeToStorage(state: ChartState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or disabled — silently ignore.
  }
}

export function useChartPersistence(): [
  ChartState,
  (next: ChartState | ((prev: ChartState) => ChartState)) => void,
] {
  const [state, setStateRaw] = useState<ChartState>(readFromStorage);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setState = useCallback(
    (next: ChartState | ((prev: ChartState) => ChartState)) => {
      setStateRaw((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        // Schedule debounced write
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          writeToStorage(resolved);
          timerRef.current = null;
        }, DEBOUNCE_MS);
        return resolved;
      });
    },
    [],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return [state, setState];
}
