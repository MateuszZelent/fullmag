/**
 * @module features/plots2d/model/plot2dTypes
 *
 * Core type definitions for the 2D Plots Workbench.
 *
 * Defines workbench modes, plane selection, store shape, and all
 * supporting types used across the plots2d feature module.
 */

// ─────────────────────────────────────────────────────────────────
// Workbench modes & planes
// ─────────────────────────────────────────────────────────────────

export type Plot2DMode = "time-series" | "spatial-slice" | "line-profile" | "spectrum";

export type SlicePlane = "xy" | "xz" | "yz";

export type XColumn = "time" | "step";

export type YScale = "linear" | "log";

export type VectorComponent = "x" | "y" | "z" | "magnitude";

// ─────────────────────────────────────────────────────────────────
// Scalar series metadata
// ─────────────────────────────────────────────────────────────────

export type ScalarSeriesKind =
  | "time"
  | "step"
  | "energy"
  | "magnetization"
  | "field"
  | "torque"
  | "solver"
  | "custom";

export type ScalarSeriesScope = "universe" | "domain" | "object" | "probe";

export interface ScalarSeriesMeta {
  key: string;
  label: string;
  unit: string | null;
  kind: ScalarSeriesKind;
  scope: ScalarSeriesScope;
  native: boolean;
  reducer?: "avg" | "sum" | "min" | "max" | "rms" | "last";
  component?: VectorComponent;
  group?: string;
}

// ─────────────────────────────────────────────────────────────────
// Columnar scalar table
// ─────────────────────────────────────────────────────────────────

/**
 * Columnar data model for scalar time-series.
 *
 * Instead of row-of-objects (`Record<string, number>[]`), data is stored
 * as typed arrays per column. This reduces GC pressure and is directly
 * consumable by ECharts dataset/series without per-row materialization.
 */
export interface ScalarTable {
  /** Ordered column keys. */
  columns: string[];
  /** Number of rows. */
  rowCount: number;
  /** Column data. Float64Array for numeric precision, number[] for sparse. */
  data: Record<string, Float64Array | number[]>;
  /** Per-column metadata, keyed by column key. */
  metaByKey: Record<string, ScalarSeriesMeta>;
  /** Backend revision of the last data merge. */
  revision: number;
  /** Total rows known at the backend. */
  totalRows: number;
}

export interface ScalarTableDelta {
  columns: string[];
  appendRows: Record<string, number[]>;
  revision: number;
  totalRows: number;
}

// ─────────────────────────────────────────────────────────────────
// Decimation
// ─────────────────────────────────────────────────────────────────

export type DecimationMethod = "none" | "stride" | "minmax" | "lttb";

export interface DecimationConfig {
  method: DecimationMethod;
  maxPoints: number;
}

export interface DecimationResult {
  method: DecimationMethod;
  inputRows: number;
  outputRows: number;
}

// ─────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────

export interface PlotPreset {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  mode: Plot2DMode;
  series: string[];
  xColumn?: XColumn;
  yScale?: YScale;
  requiredCapabilities?: string[];
}

// ─────────────────────────────────────────────────────────────────
// Chart stats (series inspector)
// ─────────────────────────────────────────────────────────────────

export interface SeriesStats {
  key: string;
  label: string;
  unit: string | null;
  count: number;
  min: number;
  max: number;
  last: number;
  delta: number;
  mean: number;
}

// ─────────────────────────────────────────────────────────────────
// Store shape
// ─────────────────────────────────────────────────────────────────

export interface Plot2DUIState {
  mode: Plot2DMode;
  activePresetId: string | null;
  activeSeriesKeys: string[];
  xColumn: XColumn;
  yScale: YScale;
  showMarkers: boolean;
  showRangeSlider: boolean;
  selectedDomainId: string | null;

  // Spatial slice config
  plane: SlicePlane;
  cutPositionPercent: number;
  sliceIndex: number | null;
  component: VectorComponent;
  colormap: string;
  showVectors: boolean;
}

export interface Plot2DScalarState {
  sessionKey: string | null;
  runId: string | null;
  stageIndex: number | null;
  revision: number;
  totalRows: number;
  rowsFingerprint: string;
  source: "empty" | "live-window" | "full-history" | "decimated-history";
  table: ScalarTable | null;
  availableSeries: ScalarSeriesMeta[];
  loading: boolean;
  error: string | null;
}

export interface Plot2DSpatialState {
  fieldRevision: number | null;
  capabilities: string[];
  loading: boolean;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Default plane logic
// ─────────────────────────────────────────────────────────────────

/**
 * Default plane for 2D plots.
 *
 * Always XY — this is the natural working plane for planar
 * micromagnetic systems (thin films, skyrmions, racetrack, STT-MRAM).
 * The user can override via toolbar/ribbon.
 */
export function defaultPlaneFor2DPlots(): SlicePlane {
  return "xy";
}

/**
 * Default slice index for a given plane and grid.
 * Single-layer axis → 0, otherwise center.
 */
export function defaultSliceForPlane(
  plane: SlicePlane,
  grid: [number, number, number],
): number {
  const depth = sliceDepthForPlane(grid, plane);
  return depth <= 1 ? 0 : Math.floor(depth / 2);
}

/**
 * Returns the depth (number of cells) along the normal axis
 * of the given plane.
 */
export function sliceDepthForPlane(
  grid: [number, number, number],
  plane: SlicePlane,
): number {
  switch (plane) {
    case "xy": return grid[2]; // normal = z
    case "xz": return grid[1]; // normal = y
    case "yz": return grid[0]; // normal = x
  }
}
