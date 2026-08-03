import type { AnalysisSurface } from "./analysisViewPreferences";

export interface AnalysisWorkspaceState {
  activeSurface: AnalysisSurface;
  comparisonDatasetRef: string | null;
  hasChartState: boolean;
  selectedDatasetRef: string | null;
  sourceChartId: string | null;
  sourceTableId: string | null;
  selectedSeriesIds: string[];
  xAxisId: string | null;
  visibleDatasetRevision: string | number | null;
}

const INITIAL_STATE: AnalysisWorkspaceState = { activeSurface: "dynamics", comparisonDatasetRef: null, hasChartState: false, selectedDatasetRef: null, selectedSeriesIds: [], sourceChartId: null, sourceTableId: null, visibleDatasetRevision: null, xAxisId: null };
const MAX_DATASET_REF_LENGTH = 160;

class AnalysisWorkspaceStore {
  private readonly listeners = new Set<() => void>();
  private state = INITIAL_STATE;

  getSnapshot = (): AnalysisWorkspaceState => this.state;
  getServerSnapshot = (): AnalysisWorkspaceState => INITIAL_STATE;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setActiveSurface(activeSurface: AnalysisSurface): void {
    this.update({
      ...this.state,
      activeSurface,
      sourceChartId: this.state.selectedDatasetRef ? `${activeSurface}:${this.state.selectedDatasetRef}` : null,
    });
  }
  setSelectedDatasetRef(selectedDatasetRef: string | null): void {
    const valid = typeof selectedDatasetRef === "string" && selectedDatasetRef.length > 0 && selectedDatasetRef.length <= MAX_DATASET_REF_LENGTH
      ? selectedDatasetRef
      : null;
    const changed = valid !== this.state.selectedDatasetRef;
    this.update({ ...this.state, hasChartState: changed ? false : this.state.hasChartState, selectedDatasetRef: valid, selectedSeriesIds: changed ? [] : this.state.selectedSeriesIds, sourceChartId: valid ? `${this.state.activeSurface}:${valid}` : null, sourceTableId: valid, visibleDatasetRevision: changed ? null : this.state.visibleDatasetRevision, xAxisId: changed ? null : this.state.xAxisId });
  }
  setComparisonDatasetRef(comparisonDatasetRef: string | null): void {
    const valid = typeof comparisonDatasetRef === "string" && comparisonDatasetRef.length > 0 && comparisonDatasetRef.length <= MAX_DATASET_REF_LENGTH
      ? comparisonDatasetRef
      : null;
    this.update({ ...this.state, comparisonDatasetRef: valid === this.state.selectedDatasetRef ? null : valid });
  }
  setVisibleDatasetRevision(visibleDatasetRevision: string | number | null): void {
    const valid = typeof visibleDatasetRevision === "string" || typeof visibleDatasetRevision === "number" ? visibleDatasetRevision : null;
    this.update({ ...this.state, visibleDatasetRevision: valid });
  }
  setChartState(xAxisId: string, selectedSeriesIds: string[]): void { this.update({ ...this.state, hasChartState: true, selectedSeriesIds: selectedSeriesIds.slice(0, 100), xAxisId: xAxisId.slice(0, 160) }); }
  reset(): void { this.update(INITIAL_STATE); }
  private update(next: AnalysisWorkspaceState): void {
    const previous = this.state;
    if (
      next.activeSurface === previous.activeSurface &&
      next.comparisonDatasetRef === previous.comparisonDatasetRef &&
      next.hasChartState === previous.hasChartState &&
      next.selectedDatasetRef === previous.selectedDatasetRef &&
      next.sourceChartId === previous.sourceChartId &&
      next.sourceTableId === previous.sourceTableId &&
      next.visibleDatasetRevision === previous.visibleDatasetRevision &&
      next.xAxisId === previous.xAxisId &&
      next.selectedSeriesIds.length === previous.selectedSeriesIds.length &&
      next.selectedSeriesIds.every((id, index) => id === previous.selectedSeriesIds[index])
    ) return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const analysisWorkspaceStore = new AnalysisWorkspaceStore();
export function resetAnalysisWorkspaceForTests(): void { analysisWorkspaceStore.reset(); }
