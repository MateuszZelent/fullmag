"use client";

/**
 * useChartPersistence — persists ChartState to localStorage so chart
 * configuration survives page refreshes and tab switches.
 *
 * Falls back to the default "energy" preset if nothing is saved.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { ChartSeriesSpec, ChartState } from "../components/plots/chartTypes";
import {
  DEFAULT_CHART_STATE,
  buildScalarSeriesSpecsForScope,
  clampSeriesByUnitLimit,
  scopeRefFromSelectedDomain,
} from "../components/plots/chartTypes";

const STORAGE_KEY = "fullmag:charts:state";
const DEBOUNCE_MS = 500;

function isChartSeriesSpec(value: unknown): value is ChartSeriesSpec {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChartSeriesSpec>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.quantityId === "string" &&
    (candidate.reducer === "scalar_native" ||
      candidate.reducer === "avg_component" ||
      candidate.reducer === "avg_magnitude" ||
      candidate.reducer === "max_magnitude") &&
    (candidate.component === null ||
      candidate.component === "x" ||
      candidate.component === "y" ||
      candidate.component === "z" ||
      candidate.component === "magnitude") &&
    (candidate.xAxis === "time" || candidate.xAxis === "step") &&
    typeof candidate.label === "string" &&
    typeof candidate.unit === "string" &&
    Boolean(candidate.scope) &&
    typeof candidate.scope === "object" &&
    (((candidate.scope as { kind?: unknown }).kind === "universe" &&
      (candidate.scope as { id?: unknown }).id === null) ||
      ((candidate.scope as { kind?: unknown }).kind === "object" &&
        typeof (candidate.scope as { id?: unknown }).id === "string"))
  );
}

function specsMatchState(args: {
  specs: ChartSeriesSpec[];
  seriesKeys: string[];
  xAxis: "time" | "step";
  selectedDomain: string | null;
}): boolean {
  const { specs, seriesKeys, xAxis, selectedDomain } = args;
  if (specs.length !== seriesKeys.length) {
    return false;
  }
  const expectedScope = scopeRefFromSelectedDomain(selectedDomain);
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const key = seriesKeys[index];
    if (!spec || spec.quantityId !== key || spec.reducer !== "scalar_native" || spec.component !== null) {
      return false;
    }
    if (spec.xAxis !== xAxis) {
      return false;
    }
    if (
      spec.scope.kind !== expectedScope.kind ||
      spec.scope.id !== expectedScope.id
    ) {
      return false;
    }
  }
  return true;
}

function readFromStorage(): ChartState {
  if (typeof window === "undefined") return DEFAULT_CHART_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHART_STATE;
    const parsed = JSON.parse(raw) as Partial<ChartState>;
    const parsedSeries = Array.isArray(parsed.activeSeriesKeys)
      ? parsed.activeSeriesKeys.filter(
          (key): key is string => typeof key === "string",
        )
      : DEFAULT_CHART_STATE.activeSeriesKeys;
    const sanitizedSeries = clampSeriesByUnitLimit(parsedSeries);
    const selectedDomain =
      typeof parsed.selectedDomain === "string"
        ? parsed.selectedDomain
        : null;
    const xColumn =
      typeof parsed.xColumn === "string" ? parsed.xColumn : DEFAULT_CHART_STATE.xColumn;
    const xAxis = xColumn === "step" ? "step" : "time";
    const parsedSpecs = Array.isArray(parsed.activeSeriesSpecs)
      ? parsed.activeSeriesSpecs.filter(isChartSeriesSpec)
      : [];
    const activeSeriesKeys = sanitizedSeries.length > 0
      ? sanitizedSeries
      : DEFAULT_CHART_STATE.activeSeriesKeys;
    const activeSeriesSpecs = specsMatchState({
      specs: parsedSpecs,
      seriesKeys: activeSeriesKeys,
      xAxis,
      selectedDomain,
    })
      ? parsedSpecs
      : buildScalarSeriesSpecsForScope({
          seriesKeys: activeSeriesKeys,
          scope: scopeRefFromSelectedDomain(selectedDomain),
          xAxis,
        });
    return {
      xColumn,
      activeSeriesKeys,
      activeSeriesSpecs,
      activePreset:
        typeof parsed.activePreset === "string"
          ? (parsed.activePreset as ChartState["activePreset"])
          : null,
      selectedDomain,
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
        // Fast path: updater returned the exact same reference — nothing changed.
        if (resolved === prev) return prev;
        const clampedKeys = clampSeriesByUnitLimit(resolved.activeSeriesKeys);
        const rawKeys = clampedKeys.length > 0
          ? clampedKeys
          : DEFAULT_CHART_STATE.activeSeriesKeys;
        // Stable reference: reuse prev array when values are identical to avoid
        // spurious downstream useMemo recomputations that cause infinite effect loops.
        const activeSeriesKeys =
          rawKeys.length === prev.activeSeriesKeys.length &&
          rawKeys.every((k, i) => k === prev.activeSeriesKeys[i])
            ? prev.activeSeriesKeys
            : rawKeys;
        const xAxis = resolved.xColumn === "step" ? "step" : "time";
        const selectedDomain = resolved.selectedDomain ?? null;
        const activeSeriesSpecs = specsMatchState({
          specs: resolved.activeSeriesSpecs,
          seriesKeys: activeSeriesKeys,
          xAxis,
          selectedDomain,
        })
          ? resolved.activeSeriesSpecs
          : buildScalarSeriesSpecsForScope({
              seriesKeys: activeSeriesKeys,
              scope: scopeRefFromSelectedDomain(selectedDomain),
              xAxis,
            });
        const sanitized: ChartState = {
          ...resolved,
          activeSeriesKeys,
          activeSeriesSpecs,
        };
        // Bail out if nothing actually changed — prevents React from scheduling a
        // re-render and breaking the effect dep chain (especially yColumns).
        if (
          sanitized.xColumn === prev.xColumn &&
          sanitized.selectedDomain === prev.selectedDomain &&
          sanitized.activePreset === prev.activePreset &&
          sanitized.activeSeriesKeys === prev.activeSeriesKeys &&
          sanitized.activeSeriesSpecs === prev.activeSeriesSpecs
        ) {
          return prev;
        }
        // Schedule debounced write
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          writeToStorage(sanitized);
          timerRef.current = null;
        }, DEBOUNCE_MS);
        return sanitized;
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
