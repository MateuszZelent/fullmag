/**
 * @module features/plots2d/store/usePlot2DStore
 *
 * Zustand store for the 2D Plots Workbench.
 *
 * Single store with three segments (per masterplan §5.2):
 * - `ui`: persisted preferences (mode, series, scale, plane, etc.)
 * - `scalar`: transient data state (table, revision, loading)
 * - `spatial`: transient spatial state (capabilities, loading)
 *
 * CRITICAL: Only `ui` is persisted. Data is never stored in localStorage.
 */

import { create } from "zustand";
import type {
  Plot2DMode,
  Plot2DUIState,
  Plot2DScalarState,
  Plot2DSpatialState,
  ScalarTable,
  ScalarTableDelta,
  ScalarSeriesMeta,
  SlicePlane,
  XColumn,
  YScale,
  VectorComponent,
} from "../model/plot2dTypes";
import { appendScalarDelta, scalarTableFingerprint } from "../model/scalarTable";
import { getPreset, matchPreset } from "../model/plotPresets";
import { persistUIState, restoreUIState } from "./persistence";

// ─────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────

const DEFAULT_UI: Plot2DUIState = {
  mode: "time-series",
  activePresetId: null,
  activeSeriesKeys: ["e_total"],
  xColumn: "time",
  yScale: "linear",
  showMarkers: false,
  showRangeSlider: false,
  selectedDomainId: null,
  plane: "xy",
  cutPositionPercent: 50,
  sliceIndex: null,
  component: "magnitude",
  colormap: "coolwarm",
  showVectors: false,
};

const DEFAULT_SCALAR: Plot2DScalarState = {
  sessionKey: null,
  runId: null,
  stageIndex: null,
  revision: 0,
  totalRows: 0,
  rowsFingerprint: "",
  source: "empty",
  table: null,
  availableSeries: [],
  loading: false,
  error: null,
};

const DEFAULT_SPATIAL: Plot2DSpatialState = {
  fieldRevision: null,
  capabilities: [],
  loading: false,
  error: null,
};

// ─────────────────────────────────────────────────────────────────
// Store type
// ─────────────────────────────────────────────────────────────────

export interface Plot2DStoreState {
  ui: Plot2DUIState;
  scalar: Plot2DScalarState;
  spatial: Plot2DSpatialState;

  // ── UI Actions ──
  setMode: (mode: Plot2DMode) => void;
  applyPreset: (id: string) => void;
  setSeries: (keys: string[]) => void;
  addSeries: (key: string) => void;
  removeSeries: (key: string) => void;
  setXColumn: (col: XColumn) => void;
  setYScale: (scale: YScale) => void;
  toggleMarkers: () => void;
  toggleRangeSlider: () => void;
  setSelectedDomain: (domainId: string | null) => void;
  setPlane: (plane: SlicePlane) => void;
  setCutPositionPercent: (value: number) => void;
  setSliceIndex: (index: number | null) => void;
  setComponent: (component: VectorComponent) => void;
  setColormap: (colormap: string) => void;
  toggleVectors: () => void;

  // ── Scalar Data Actions ──
  hydrateScalarMeta: (meta: ScalarSeriesMeta[]) => void;
  hydrateScalarTable: (table: ScalarTable, source: Plot2DScalarState["source"]) => void;
  appendScalarDelta: (delta: ScalarTableDelta) => void;
  setScalarLoading: (loading: boolean) => void;
  setScalarError: (error: string | null) => void;

  // ── Session lifecycle ──
  resetForSession: (sessionKey: string | null) => void;
}

// ─────────────────────────────────────────────────────────────────
// Debounced persistence
// ─────────────────────────────────────────────────────────────────

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500;

function debouncedPersist(ui: Plot2DUIState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistUIState(ui), PERSIST_DEBOUNCE_MS);
}

// ─────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────

const restoredUI = restoreUIState();

export const usePlot2DStore = create<Plot2DStoreState>((set, get) => ({
  ui: restoredUI ?? DEFAULT_UI,
  scalar: DEFAULT_SCALAR,
  spatial: DEFAULT_SPATIAL,

  // ── UI Actions ──

  setMode: (mode) => {
    set((s) => {
      const nextUI = { ...s.ui, mode };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  applyPreset: (id) => {
    const preset = getPreset(id);
    if (!preset) return;
    set((s) => {
      const nextUI = {
        ...s.ui,
        activePresetId: id,
        activeSeriesKeys: [...preset.series],
        ...(preset.xColumn ? { xColumn: preset.xColumn } : {}),
        ...(preset.yScale ? { yScale: preset.yScale } : {}),
      };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setSeries: (keys) => {
    set((s) => {
      const activePresetId = matchPreset(keys);
      const nextUI = { ...s.ui, activeSeriesKeys: keys, activePresetId };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  addSeries: (key) => {
    set((s) => {
      if (s.ui.activeSeriesKeys.includes(key)) return s;
      const keys = [...s.ui.activeSeriesKeys, key];
      const activePresetId = matchPreset(keys);
      const nextUI = { ...s.ui, activeSeriesKeys: keys, activePresetId };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  removeSeries: (key) => {
    set((s) => {
      const keys = s.ui.activeSeriesKeys.filter((k) => k !== key);
      const activePresetId = matchPreset(keys);
      const nextUI = { ...s.ui, activeSeriesKeys: keys, activePresetId };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setXColumn: (xColumn) => {
    set((s) => {
      const nextUI = { ...s.ui, xColumn };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setYScale: (yScale) => {
    set((s) => {
      const nextUI = { ...s.ui, yScale };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  toggleMarkers: () => {
    set((s) => {
      const nextUI = { ...s.ui, showMarkers: !s.ui.showMarkers };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  toggleRangeSlider: () => {
    set((s) => {
      const nextUI = { ...s.ui, showRangeSlider: !s.ui.showRangeSlider };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setSelectedDomain: (domainId) => {
    set((s) => {
      const nextUI = { ...s.ui, selectedDomainId: domainId };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setPlane: (plane) => {
    set((s) => {
      const nextUI = { ...s.ui, plane };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setCutPositionPercent: (value) => {
    set((s) => {
      const nextUI = { ...s.ui, cutPositionPercent: Math.max(0, Math.min(100, value)) };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setSliceIndex: (index) => {
    set((s) => {
      const nextUI = { ...s.ui, sliceIndex: index };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setComponent: (component) => {
    set((s) => {
      const nextUI = { ...s.ui, component };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  setColormap: (colormap) => {
    set((s) => {
      const nextUI = { ...s.ui, colormap };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  toggleVectors: () => {
    set((s) => {
      const nextUI = { ...s.ui, showVectors: !s.ui.showVectors };
      debouncedPersist(nextUI);
      return { ui: nextUI };
    });
  },

  // ── Scalar Data Actions ──

  hydrateScalarMeta: (meta) => {
    set((s) => ({
      scalar: { ...s.scalar, availableSeries: meta },
    }));
  },

  hydrateScalarTable: (table, source) => {
    set((s) => ({
      scalar: {
        ...s.scalar,
        table,
        source,
        revision: table.revision,
        totalRows: table.totalRows,
        rowsFingerprint: scalarTableFingerprint(table),
        loading: false,
        error: null,
      },
    }));
  },

  appendScalarDelta: (delta) => {
    set((s) => {
      if (!s.scalar.table) return s;
      const next = appendScalarDelta(s.scalar.table, delta);
      return {
        scalar: {
          ...s.scalar,
          table: next,
          revision: delta.revision,
          totalRows: delta.totalRows,
          rowsFingerprint: scalarTableFingerprint(next),
        },
      };
    });
  },

  setScalarLoading: (loading) => {
    set((s) => ({
      scalar: { ...s.scalar, loading },
    }));
  },

  setScalarError: (error) => {
    set((s) => ({
      scalar: { ...s.scalar, error, loading: false },
    }));
  },

  // ── Session lifecycle ──

  resetForSession: (sessionKey) => {
    set((s) => ({
      scalar: {
        ...DEFAULT_SCALAR,
        sessionKey,
      },
      spatial: DEFAULT_SPATIAL,
      // Keep UI — preferences persist across sessions
    }));
  },
}));

// ─────────────────────────────────────────────────────────────────
// Selectors — subscribe to minimal slices
// ─────────────────────────────────────────────────────────────────

export const selectUI = (s: Plot2DStoreState) => s.ui;
export const selectMode = (s: Plot2DStoreState) => s.ui.mode;
export const selectActiveSeriesKeys = (s: Plot2DStoreState) => s.ui.activeSeriesKeys;
export const selectActivePresetId = (s: Plot2DStoreState) => s.ui.activePresetId;
export const selectXColumn = (s: Plot2DStoreState) => s.ui.xColumn;
export const selectYScale = (s: Plot2DStoreState) => s.ui.yScale;
export const selectShowMarkers = (s: Plot2DStoreState) => s.ui.showMarkers;
export const selectShowRangeSlider = (s: Plot2DStoreState) => s.ui.showRangeSlider;
export const selectPlane = (s: Plot2DStoreState) => s.ui.plane;
export const selectCutPositionPercent = (s: Plot2DStoreState) => s.ui.cutPositionPercent;
export const selectComponent = (s: Plot2DStoreState) => s.ui.component;

export const selectScalarTable = (s: Plot2DStoreState) => s.scalar.table;
export const selectScalarSource = (s: Plot2DStoreState) => s.scalar.source;
export const selectScalarLoading = (s: Plot2DStoreState) => s.scalar.loading;
export const selectScalarError = (s: Plot2DStoreState) => s.scalar.error;
export const selectScalarTotalRows = (s: Plot2DStoreState) => s.scalar.totalRows;
export const selectAvailableSeries = (s: Plot2DStoreState) => s.scalar.availableSeries;
export const selectRowsFingerprint = (s: Plot2DStoreState) => s.scalar.rowsFingerprint;
