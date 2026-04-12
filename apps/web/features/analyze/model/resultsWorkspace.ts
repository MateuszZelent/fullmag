/**
 * Results workspace model types.
 *
 * First-class domain model for the results subsystem as described in §9
 * of the implementation plan. Replaces flat `res-*` string IDs with typed
 * node structures that integrate with the NodeKind / Inspector / Icon registries.
 */

// ── Result node kind discriminator ───────────────────────────

export type ResultNodeKind =
  | "dataset"
  | "plot_group"
  | "table"
  | "analysis"
  | "export"
  | "report";

// ── Node interfaces ──────────────────────────────────────────

export interface ResultNodeBase {
  id: string;
  label: string;
  pinned: boolean;
  createdAt: number;
}

/** A dataset is a collection of solution outputs from a study run. */
export interface DatasetNode extends ResultNodeBase {
  nodeKind: "dataset";
  /** Which study/solution produced this dataset. */
  sourceStudyId: string | null;
  sourceSolutionId: string | null;
  /** Number of time-samples / field frames recorded. */
  sampleCount: number;
  /** Whether final-state snapshot is available. */
  hasFinalState: boolean;
  /** Whether eigen data is included. */
  hasEigen: boolean;
  eigenModeCount: number;
  /** Whether dispersion data is present. */
  hasDispersion: boolean;
}

/** A group of related plots, typically from one dataset. */
export interface PlotGroupNode extends ResultNodeBase {
  nodeKind: "plot_group";
  sourceDatasetId: string;
  plots: PlotEntry[];
  display: PlotDisplayState;
}

export interface PlotEntry {
  id: string;
  label: string;
  /** Quantity to plot (e.g. "mx", "energy_total"). */
  quantityId: string;
  /** Plot style. */
  style: "line" | "scatter" | "heatmap" | "bar";
  visible: boolean;
}

export interface PlotDisplayState {
  xAxis: string;
  yAxis: string;
  normalizeY: boolean;
  logScale: boolean;
  autoRange: boolean;
}

/** A tabular data view. */
export interface TableNode extends ResultNodeBase {
  nodeKind: "table";
  sourceDatasetId: string;
  columns: TableColumnEntry[];
  sortColumn: string | null;
  sortDirection: "asc" | "desc";
  pageSize: number;
}

export interface TableColumnEntry {
  id: string;
  label: string;
  quantityId: string;
  visible: boolean;
  width: number | null;
}

/** An analysis workspace (eigenmodes, vortex, custom). */
export interface AnalysisWorkspaceNode extends ResultNodeBase {
  nodeKind: "analysis";
  analysisKind: AnalysisKind;
  config: Record<string, unknown>;
  status: "idle" | "running" | "completed" | "error";
}

export type AnalysisKind =
  | "eigenmodes"
  | "vortex"
  | "fmr"
  | "hysteresis"
  | "custom";

/** An export definition (VTK, JSON, etc.). */
export interface ExportNode extends ResultNodeBase {
  nodeKind: "export";
  format: "vtk" | "json" | "csv" | "hdf5";
  quantityIds: string[];
  frameRange: [number, number] | null;
}

/** A report aggregation (summary of analyses, plots, tables). */
export interface ReportNode extends ResultNodeBase {
  nodeKind: "report";
  sections: ReportSectionEntry[];
}

export interface ReportSectionEntry {
  id: string;
  label: string;
  /** Reference to a plot group, table, or analysis workspace. */
  sourceNodeId: string;
  sourceNodeKind: "plot_group" | "table" | "analysis";
}

// ── Union type ───────────────────────────────────────────────

export type ResultNode =
  | DatasetNode
  | PlotGroupNode
  | TableNode
  | AnalysisWorkspaceNode
  | ExportNode
  | ReportNode;

// ── Top-level workspace state ────────────────────────────────

export interface ResultsWorkspaceState {
  datasets: DatasetNode[];
  plotGroups: PlotGroupNode[];
  tables: TableNode[];
  analyses: AnalysisWorkspaceNode[];
  exports: ExportNode[];
  reports: ReportNode[];
  activeResultNodeId: string | null;
}

export const EMPTY_RESULTS_WORKSPACE: ResultsWorkspaceState = {
  datasets: [],
  plotGroups: [],
  tables: [],
  analyses: [],
  exports: [],
  reports: [],
  activeResultNodeId: null,
};

// ── Helper: find a result node by ID across all collections ──

export function findResultNode(
  state: ResultsWorkspaceState,
  nodeId: string,
): ResultNode | undefined {
  const all: ResultNode[] = [
    ...state.datasets,
    ...state.plotGroups,
    ...state.tables,
    ...state.analyses,
    ...state.exports,
    ...state.reports,
  ];
  return all.find((n) => n.id === nodeId);
}

/** List all result nodes ordered by creation time. */
export function allResultNodes(state: ResultsWorkspaceState): ResultNode[] {
  return [
    ...state.datasets,
    ...state.plotGroups,
    ...state.tables,
    ...state.analyses,
    ...state.exports,
    ...state.reports,
  ].sort((a, b) => a.createdAt - b.createdAt);
}
