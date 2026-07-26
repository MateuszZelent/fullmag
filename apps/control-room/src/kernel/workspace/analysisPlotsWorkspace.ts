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

export interface AnalysisPlotsWorkspaceState {
  activeSurface: AnalysisWorkbenchSurface;
  availableColumns: AxisColumnDescriptor[];
  range: AnalysisChartRange | null;
  selectedPoint: AnalysisChartCursorPoint | null;
  xAxisId: string;
  yAxisIds: string[];
}

type AnalysisPlotsWorkspaceListener = () => void;

const INITIAL_STATE: AnalysisPlotsWorkspaceState = {
  activeSurface: "overview",
  availableColumns: [],
  range: null,
  selectedPoint: null,
  xAxisId: "step",
  yAxisIds: ["mx", "my", "mz", "e_total"],
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

  setAxes(xAxisId: string, yAxisIds: string[]): void {
    if (
      this.state.xAxisId === xAxisId &&
      stringArraysEqual(this.state.yAxisIds, yAxisIds)
    ) {
      return;
    }
    this.setState({
      ...this.state,
      xAxisId,
      yAxisIds,
    });
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
    });
  }

  clearRange(): void {
    if (!this.state.range) return;
    this.setState({
      ...this.state,
      range: null,
    });
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
