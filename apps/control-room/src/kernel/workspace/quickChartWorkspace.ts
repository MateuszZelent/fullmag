export interface PinnedQuickChart {
  chartId: string;
  tableId: string;
  xAxisId: string;
  yAxisIds: readonly string[];
}

export interface QuickChartWorkspaceState {
  pinned: PinnedQuickChart | null;
}

type QuickChartWorkspaceListener = () => void;

const INITIAL_STATE: QuickChartWorkspaceState = { pinned: null };

class QuickChartWorkspaceStore {
  private readonly listeners = new Set<QuickChartWorkspaceListener>();
  private state = INITIAL_STATE;

  getSnapshot = (): QuickChartWorkspaceState => this.state;

  subscribe = (listener: QuickChartWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  pin(chart: PinnedQuickChart): void {
    const next: PinnedQuickChart = {
      chartId: chart.chartId,
      tableId: chart.tableId,
      xAxisId: chart.xAxisId,
      yAxisIds: [...new Set(chart.yAxisIds)].filter((id) => id !== chart.xAxisId),
    };
    if (
      this.state.pinned?.chartId === next.chartId &&
      this.state.pinned.tableId === next.tableId &&
      this.state.pinned.xAxisId === next.xAxisId &&
      sameIds(this.state.pinned.yAxisIds, next.yAxisIds)
    ) {
      return;
    }
    this.state = { pinned: next };
    this.notify();
  }

  clear(): void {
    if (!this.state.pinned) return;
    this.state = INITIAL_STATE;
    this.notify();
  }

  reset(): void {
    this.state = INITIAL_STATE;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export const quickChartWorkspaceStore = new QuickChartWorkspaceStore();

export function resetQuickChartWorkspaceForTests(): void {
  quickChartWorkspaceStore.reset();
}
