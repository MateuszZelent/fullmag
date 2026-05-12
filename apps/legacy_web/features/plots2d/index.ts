/**
 * @module features/plots2d
 *
 * Public API for the 2D Plots Workbench feature module.
 */

// ── Components ──
export { Plot2DWorkbench } from "./components/Plot2DWorkbench";
export { Plot2DToolbar } from "./components/Plot2DToolbar";
export { ScalarTimeSeriesECharts } from "./components/ScalarTimeSeriesECharts";
export { SeriesInspector } from "./components/SeriesInspector";
export { Plot2DStatusBar } from "./components/Plot2DStatusBar";

// ── Store ──
export { usePlot2DStore } from "./store/usePlot2DStore";
export type { Plot2DStoreState } from "./store/usePlot2DStore";

// ── Hooks ──
export { useScalarSeriesData } from "./hooks/useScalarSeriesData";

// ── Model ──
export type {
  Plot2DMode,
  SlicePlane,
  XColumn,
  YScale,
  ScalarTable,
  ScalarTableDelta,
  ScalarSeriesMeta,
  PlotPreset,
  Plot2DUIState,
  Plot2DScalarState,
  Plot2DSpatialState,
  DecimationMethod,
  DecimationConfig,
  SeriesStats,
  VectorComponent,
} from "./model/plot2dTypes";
export { defaultPlaneFor2DPlots, defaultSliceForPlane, sliceDepthForPlane } from "./model/plot2dTypes";

export {
  scalarTableFromMatrix,
  scalarTableFromRows,
  emptyScalarTable,
  appendScalarDelta,
  getColumn,
  columnHasData,
  lastColumnValue,
  computeColumnStats,
  serializeScalarTableCsv,
  scalarTableFingerprint,
} from "./model/scalarTable";

export {
  buildScalarSeriesMeta,
  getFallbackSeriesMeta,
  buildSeriesMetaMap,
  groupSeriesMeta,
} from "./model/scalarSeriesMeta";

export {
  PLOT_PRESETS,
  PRESET_ORDER,
  getPreset,
  getPresetsInOrder,
  matchPreset,
} from "./model/plotPresets";

export {
  decimate,
  decimateStride,
  decimateMinMaxBucket,
  decimateLTTB,
} from "./model/chartDecimation";

export { buildScalarTimeSeriesOption } from "./model/echartsOptions";
