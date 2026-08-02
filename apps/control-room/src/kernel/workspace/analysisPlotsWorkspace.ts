import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { AxisColumnDescriptor } from "@/shared/domain/analysis/TableColumnList";

interface AnalysisChartRange {
  fromValue: number;
  toValue: number;
}

export type AnalysisWorkbenchSurface =
  | "overview"
  | "energy"
  | "dynamics"
  | "convergence"
  | "frequency";

/**
 * `following` — chart updates on every relevant resource revision.
 * `paused` — chart is frozen at a specific revision; updates are suppressed
 *   until the user explicitly resumes. Resume executes exactly one fetch.
 */
export type ChartLiveMode = "following" | "paused";

export type AnalysisChartRangeMode =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed" }
  | { mode: "fullDecimated" };

export interface AnalysisPlotsWorkspaceState {
  activeSurface: AnalysisWorkbenchSurface;
  availableColumns: AxisColumnDescriptor[];
  /** Monotonic local command consumed by the mounted ECharts owner only. */
  fitRequest: number;
  /** Series IDs selected for chart rendering; local UI state only. */
  selectedSeriesIds: readonly string[];
  liveMode: ChartLiveMode;
  range: AnalysisChartRange | null;
  rangeMode: AnalysisChartRangeMode;
  targetPoints: 160 | 400 | 800 | 1600 | 3200 | 5000;
  selectedPoint: AnalysisChartCursorPoint | null;
  xAxisId: string;
}

type AnalysisPlotsWorkspaceListener = () => void;

const INITIAL_STATE: AnalysisPlotsWorkspaceState = {
  activeSurface: "overview",
  availableColumns: [],
  fitRequest: 0,
  selectedSeriesIds: [
    "data.table:default:step:mx",
    "data.table:default:step:my",
    "data.table:default:step:mz",
    "data.table:default:step:e_total",
  ],
  liveMode: "following",
  range: null,
  rangeMode: { mode: "follow" },
  targetPoints: 1600,
  selectedPoint: null,
  xAxisId: "step",
};

class AnalysisPlotsWorkspaceStore {
  private readonly listeners = new Set<AnalysisPlotsWorkspaceListener>();
  private state: AnalysisPlotsWorkspaceState = INITIAL_STATE;

  getSnapshot = (): AnalysisPlotsWorkspaceState => this.state;

  subscribe = (listener: AnalysisPlotsWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setState(nextState: AnalysisPlotsWorkspaceState): void {
    if (this.state === nextState) return;
    this.state = nextState;
    this.notify();
  }

  setActiveSurface(activeSurface: AnalysisWorkbenchSurface): void {
    if (this.state.activeSurface === activeSurface) return;
    this.setState({ ...this.state, activeSurface });
  }

  setAvailableColumns(availableColumns: AxisColumnDescriptor[]): void {
    if (columnDescriptorsEqual(this.state.availableColumns, availableColumns)) {
      return;
    }
    this.setState({
      ...this.state,
      availableColumns,
    });
  }

  setXAxisId(xAxisId: string): void {
    if (this.state.xAxisId === xAxisId) return;
    this.setState({
      ...this.state,
      xAxisId,
    });
  }

  setSelectedSeriesIds(selectedSeriesIds: readonly string[]): void {
    const next = [...new Set(selectedSeriesIds)];
    if (stringArraysEqual(this.state.selectedSeriesIds, next)) return;
    this.setState({ ...this.state, selectedSeriesIds: next });
  }

  setRange(range: AnalysisChartRange): void {
    if (
      this.state.range?.fromValue === range.fromValue &&
      this.state.range?.toValue === range.toValue
    ) {
      return;
    }
    this.setState({
      ...this.state,
      range,
      rangeMode: { mode: "fixed" },
    });
  }

  clearRange(): void {
    if (!this.state.range) return;
    this.setState({
      ...this.state,
      range: null,
      rangeMode: { mode: "follow" },
    });
  }

  setRangeMode(rangeMode: AnalysisChartRangeMode): void {
    if (rangeModeEqual(this.state.rangeMode, rangeMode) &&
      (rangeMode.mode === "fixed" ? this.state.range !== null : this.state.range === null)) {
      return;
    }
    this.setState({
      ...this.state,
      range: rangeMode.mode === "fixed" ? this.state.range : null,
      rangeMode,
    });
  }

  setTargetPoints(targetPoints: AnalysisPlotsWorkspaceState["targetPoints"]): void {
    if (this.state.targetPoints === targetPoints) return;
    this.setState({ ...this.state, targetPoints });
  }

  setLiveMode(liveMode: ChartLiveMode): void {
    if (this.state.liveMode === liveMode) return;
    this.setState({ ...this.state, liveMode });
  }

  requestFitView(): void {
    const fitRequest =
      this.state.fitRequest === Number.MAX_SAFE_INTEGER
        ? 1
        : this.state.fitRequest + 1;
    this.setState({ ...this.state, fitRequest });
  }

  setSelectedPoint(selectedPoint: AnalysisChartCursorPoint | null): void {
    if (chartCursorPointsEqual(this.state.selectedPoint, selectedPoint)) return;
    this.setState({
      ...this.state,
      selectedPoint,
    });
  }

  reset(): void {
    this.setState(INITIAL_STATE);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const analysisPlotsWorkspaceStore = new AnalysisPlotsWorkspaceStore();

export function resetAnalysisPlotsWorkspaceForTests(): void {
  analysisPlotsWorkspaceStore.reset();
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function columnDescriptorsEqual(
  left: readonly AxisColumnDescriptor[],
  right: readonly AxisColumnDescriptor[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        value.column_id === other?.column_id &&
        value.label === other.label &&
        value.unit === other.unit
      );
    })
  );
}

function chartCursorPointsEqual(
  left: AnalysisChartCursorPoint | null,
  right: AnalysisChartCursorPoint | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.seriesId === right.seriesId &&
    left.quantity === right.quantity &&
    left.source.tableId === right.source.tableId &&
    left.source.resourceKey === right.source.resourceKey &&
    left.point.rowIndex === right.point.rowIndex &&
    left.point.x === right.point.x &&
    left.point.y === right.point.y
  );
}

function rangeModeEqual(
  left: AnalysisChartRangeMode,
  right: AnalysisChartRangeMode,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "tailRows" && right.mode === "tailRows") {
    return left.rows === right.rows;
  }
  if (left.mode === "tailTime" && right.mode === "tailTime") {
    return left.durationS === right.durationS;
  }
  return true;
}
