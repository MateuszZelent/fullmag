import type { TableRowsResource } from "@/kernel/api/apiTypes";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

export interface AnalysisTableState {
  cursor: number | undefined;
  visibleTable: TableRowsResource | null;
}

export interface AnalysisChartRange {
  fromValue: number;
  toValue: number;
}

export interface AnalysisPlotsWorkspaceState {
  range: AnalysisChartRange | null;
  selectedPoint: AnalysisChartCursorPoint | null;
  tableState: AnalysisTableState;
  xAxisId: string;
  yAxisIds: string[];
}

type AnalysisPlotsWorkspaceListener = () => void;

const INITIAL_STATE: AnalysisPlotsWorkspaceState = {
  range: null,
  selectedPoint: null,
  tableState: {
    cursor: undefined,
    visibleTable: null,
  },
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

  setTableState(tableState: AnalysisTableState): void {
    if (this.state.tableState === tableState) return;
    this.setState({
      ...this.state,
      tableState,
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
