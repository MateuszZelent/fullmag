/**
 * @module features/plots2d/store/persistence
 *
 * Persistence adapter for the Plot2D store.
 *
 * CRITICAL RULE: Only UI preferences are persisted to localStorage.
 * Data (rows, tables, history) is NEVER persisted — it must be
 * fetched fresh from the backend on each session.
 */

import type { Plot2DUIState } from "../model/plot2dTypes";

const STORAGE_KEY = "fullmag:plots2d:ui";
const STORAGE_VERSION = 2;

interface PersistedState {
  version: number;
  ui: Plot2DUIState;
}

/**
 * Save UI state to localStorage.
 * Debounced by the caller (store middleware or explicit call).
 */
export function persistUIState(ui: Plot2DUIState): void {
  try {
    const payload: PersistedState = {
      version: STORAGE_VERSION,
      ui,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Silently ignore quota/security errors
  }
}

/**
 * Restore UI state from localStorage.
 * Returns null if no saved state or incompatible version.
 */
export function restoreUIState(): Plot2DUIState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      !("ui" in parsed)
    ) {
      return null;
    }

    const state = parsed as PersistedState;
    if (state.version !== STORAGE_VERSION) {
      // Version mismatch — discard old state
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return validateUIState(state.ui);
  } catch {
    return null;
  }
}

/**
 * Validate and sanitize a restored UI state.
 * Ensures all fields are within valid ranges.
 */
function validateUIState(ui: unknown): Plot2DUIState | null {
  if (!ui || typeof ui !== "object") return null;
  const s = ui as Record<string, unknown>;

  // Validate critical fields
  const validModes = ["time-series", "spatial-slice", "line-profile", "spectrum"];
  const validPlanes = ["xy", "xz", "yz"];
  const validXColumns = ["time", "step"];
  const validYScales = ["linear", "log"];
  const validComponents = ["x", "y", "z", "magnitude"];

  return {
    mode: validModes.includes(s.mode as string) ? (s.mode as Plot2DUIState["mode"]) : "time-series",
    activePresetId: typeof s.activePresetId === "string" ? s.activePresetId : null,
    activeSeriesKeys: Array.isArray(s.activeSeriesKeys)
      ? (s.activeSeriesKeys as string[]).filter((k) => typeof k === "string")
      : ["e_total"],
    xColumn: validXColumns.includes(s.xColumn as string) ? (s.xColumn as Plot2DUIState["xColumn"]) : "time",
    yScale: validYScales.includes(s.yScale as string) ? (s.yScale as Plot2DUIState["yScale"]) : "linear",
    showMarkers: typeof s.showMarkers === "boolean" ? s.showMarkers : false,
    showRangeSlider: typeof s.showRangeSlider === "boolean" ? s.showRangeSlider : false,
    selectedDomainId: typeof s.selectedDomainId === "string" ? s.selectedDomainId : null,
    plane: validPlanes.includes(s.plane as string) ? (s.plane as Plot2DUIState["plane"]) : "xy",
    cutPositionPercent: typeof s.cutPositionPercent === "number" ? Math.max(0, Math.min(100, s.cutPositionPercent)) : 50,
    sliceIndex: typeof s.sliceIndex === "number" ? s.sliceIndex : null,
    component: validComponents.includes(s.component as string) ? (s.component as Plot2DUIState["component"]) : "magnitude",
    colormap: typeof s.colormap === "string" ? s.colormap : "coolwarm",
    showVectors: typeof s.showVectors === "boolean" ? s.showVectors : false,
  };
}

/**
 * Clear persisted state.
 */
export function clearPersistedState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silently ignore
  }
}
