export interface LiveChartRangeView {
  fromSI: number;
  toSI: number;
}

export interface LiveChartCursorPoint {
  pointIndex: number;
  revision: string | number;
  seriesId: string;
  x: number;
  y: number;
}

export interface LiveChartsWorkspaceState {
  range: LiveChartRangeView | null;
  selectedDescriptorId: string | null;
  selectedPoint: LiveChartCursorPoint | null;
}

type WorkspaceListener = () => void;

const INITIAL_STATE: LiveChartsWorkspaceState = {
  range: null,
  selectedDescriptorId: null,
  selectedPoint: null,
};

class LiveChartsWorkspaceStore {
  private readonly listeners = new Set<WorkspaceListener>();
  private state = INITIAL_STATE;

  getSnapshot = (): LiveChartsWorkspaceState => this.state;
  getServerSnapshot = (): LiveChartsWorkspaceState => INITIAL_STATE;

  subscribe = (listener: WorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSelectedDescriptorId(selectedDescriptorId: string | null): void {
    if (this.state.selectedDescriptorId === selectedDescriptorId) return;
    this.setState({ ...this.state, selectedDescriptorId });
  }

  setSelectedPoint(selectedPoint: LiveChartCursorPoint | null): void {
    if (pointsEqual(this.state.selectedPoint, selectedPoint)) return;
    this.setState({ ...this.state, selectedPoint });
  }

  setRange(range: LiveChartRangeView): void {
    const nextRange = Number.isFinite(range.fromSI) && Number.isFinite(range.toSI) && range.fromSI < range.toSI
      ? range
      : null;
    if (rangesEqual(this.state.range, nextRange)) return;
    this.setState({ ...this.state, range: nextRange });
  }

  clearRange(): void {
    if (!this.state.range) return;
    this.setState({ ...this.state, range: null });
  }

  reset(): void {
    this.setState(INITIAL_STATE);
  }

  private setState(state: LiveChartsWorkspaceState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

function rangesEqual(left: LiveChartRangeView | null, right: LiveChartRangeView | null): boolean {
  return left === right || Boolean(left && right && left.fromSI === right.fromSI && left.toSI === right.toSI);
}

function pointsEqual(left: LiveChartCursorPoint | null, right: LiveChartCursorPoint | null): boolean {
  return left === right || Boolean(
    left && right &&
    left.pointIndex === right.pointIndex && left.revision === right.revision &&
    left.seriesId === right.seriesId && left.x === right.x && left.y === right.y,
  );
}

export const liveChartsWorkspaceStore = new LiveChartsWorkspaceStore();

export function resetLiveChartsWorkspaceForTests(): void {
  liveChartsWorkspaceStore.reset();
}
