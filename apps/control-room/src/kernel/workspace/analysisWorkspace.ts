import type { AnalysisSurface } from "./analysisViewPreferences";

export interface AnalysisWorkspaceState {
  activeSurface: AnalysisSurface;
  activeDescriptorId: string | null;
  activeDescriptorSelectedSeriesIds: string[];
  comparisonDatasetRef: string | null;
  comparisonSelectedSeriesKeys: string[];
  focusedChartId: string | null;
  hasComparisonSelection: boolean;
  hasChartState: boolean;
  selectedDatasetRef: string | null;
  sourceChartId: string | null;
  sourceTableId: string | null;
  selectedSeriesIds: string[];
  xAxisId: string | null;
  visibleDatasetRevision: string | number | null;
}

const INITIAL_STATE: AnalysisWorkspaceState = { activeSurface: "dynamics", activeDescriptorId: null, activeDescriptorSelectedSeriesIds: [], comparisonDatasetRef: null, comparisonSelectedSeriesKeys: [], focusedChartId: null, hasChartState: false, hasComparisonSelection: false, selectedDatasetRef: null, selectedSeriesIds: [], sourceChartId: null, sourceTableId: null, visibleDatasetRevision: null, xAxisId: null };
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
    const sourceChartId = this.state.selectedDatasetRef ? `${activeSurface}:${this.state.selectedDatasetRef}` : null;
    this.update({
      ...this.state,
      activeSurface,
      activeDescriptorId: activeSurface === this.state.activeSurface ? this.state.activeDescriptorId : null,
      activeDescriptorSelectedSeriesIds: activeSurface === this.state.activeSurface ? this.state.activeDescriptorSelectedSeriesIds : [],
      focusedChartId: sourceChartId,
      sourceChartId,
    });
  }
  setSelectedDatasetRef(selectedDatasetRef: string | null): void {
    const valid = typeof selectedDatasetRef === "string" && selectedDatasetRef.length > 0 && selectedDatasetRef.length <= MAX_DATASET_REF_LENGTH
      ? selectedDatasetRef
      : null;
    const changed = valid !== this.state.selectedDatasetRef;
    const sourceChartId = valid ? `${this.state.activeSurface}:${valid}` : null;
    this.update({ ...this.state, activeDescriptorId: changed ? null : this.state.activeDescriptorId, activeDescriptorSelectedSeriesIds: changed ? [] : this.state.activeDescriptorSelectedSeriesIds, comparisonDatasetRef: changed ? null : this.state.comparisonDatasetRef, comparisonSelectedSeriesKeys: changed ? [] : this.state.comparisonSelectedSeriesKeys, focusedChartId: changed ? sourceChartId : this.state.focusedChartId, hasChartState: changed ? false : this.state.hasChartState, hasComparisonSelection: changed ? false : this.state.hasComparisonSelection, selectedDatasetRef: valid, selectedSeriesIds: changed ? [] : this.state.selectedSeriesIds, sourceChartId, sourceTableId: valid, visibleDatasetRevision: changed ? null : this.state.visibleDatasetRevision, xAxisId: changed ? null : this.state.xAxisId });
  }
  setComparisonDatasetRef(comparisonDatasetRef: string | null): void {
    const valid = typeof comparisonDatasetRef === "string" && comparisonDatasetRef.length > 0 && comparisonDatasetRef.length <= MAX_DATASET_REF_LENGTH
      ? comparisonDatasetRef
      : null;
    const next = valid === this.state.selectedDatasetRef ? null : valid;
    const changed = next !== this.state.comparisonDatasetRef;
    this.update({ ...this.state, activeDescriptorId: changed ? null : this.state.activeDescriptorId, activeDescriptorSelectedSeriesIds: changed ? [] : this.state.activeDescriptorSelectedSeriesIds, comparisonDatasetRef: next, comparisonSelectedSeriesKeys: changed ? [] : this.state.comparisonSelectedSeriesKeys, focusedChartId: changed ? this.state.sourceChartId : this.state.focusedChartId, hasComparisonSelection: changed ? false : this.state.hasComparisonSelection });
  }
  setVisibleDatasetRevision(visibleDatasetRevision: string | number | null): void {
    const valid = typeof visibleDatasetRevision === "string" || typeof visibleDatasetRevision === "number" ? visibleDatasetRevision : null;
    this.update({ ...this.state, visibleDatasetRevision: valid });
  }
  setActiveDescriptorId(activeDescriptorId: string | null): void {
    const valid = typeof activeDescriptorId === "string" && activeDescriptorId.length > 0 && activeDescriptorId.length <= 512
      ? activeDescriptorId
      : null;
    this.update({ ...this.state, activeDescriptorId: valid, activeDescriptorSelectedSeriesIds: valid === this.state.activeDescriptorId ? this.state.activeDescriptorSelectedSeriesIds : [] });
  }
  setActiveDescriptorSelection(activeDescriptorId: string, selectedSeriesIds: string[]): void {
    if (activeDescriptorId !== this.state.activeDescriptorId) return;
    this.update({ ...this.state, activeDescriptorSelectedSeriesIds: [...new Set(selectedSeriesIds)].slice(0, 100) });
  }
  setChartState(xAxisId: string, selectedSeriesIds: string[]): void { this.update({ ...this.state, hasChartState: true, selectedSeriesIds: selectedSeriesIds.slice(0, 100), xAxisId: xAxisId.slice(0, 160) }); }
  setFocusedChartId(focusedChartId: string | null): void {
    const valid = typeof focusedChartId === "string" && focusedChartId.length > 0 && focusedChartId.length <= 512
      ? focusedChartId
      : null;
    this.update({ ...this.state, focusedChartId: valid });
  }
  setComparisonSelection(comparisonSelectedSeriesKeys: string[]): void {
    this.update({ ...this.state, comparisonSelectedSeriesKeys: [...new Set(comparisonSelectedSeriesKeys)].slice(0, 100), hasComparisonSelection: true });
  }
  clearComparisonSelection(): void { this.setComparisonSelection([]); }
  reset(): void { this.update(INITIAL_STATE); }
  private update(next: AnalysisWorkspaceState): void {
    const previous = this.state;
    if (
      next.activeSurface === previous.activeSurface &&
      next.activeDescriptorId === previous.activeDescriptorId &&
      next.activeDescriptorSelectedSeriesIds.length === previous.activeDescriptorSelectedSeriesIds.length &&
      next.activeDescriptorSelectedSeriesIds.every((id, index) => id === previous.activeDescriptorSelectedSeriesIds[index]) &&
      next.comparisonDatasetRef === previous.comparisonDatasetRef &&
      next.focusedChartId === previous.focusedChartId &&
      next.hasComparisonSelection === previous.hasComparisonSelection &&
      next.hasChartState === previous.hasChartState &&
      next.selectedDatasetRef === previous.selectedDatasetRef &&
      next.sourceChartId === previous.sourceChartId &&
      next.sourceTableId === previous.sourceTableId &&
      next.visibleDatasetRevision === previous.visibleDatasetRevision &&
      next.xAxisId === previous.xAxisId &&
      next.comparisonSelectedSeriesKeys.length === previous.comparisonSelectedSeriesKeys.length &&
      next.comparisonSelectedSeriesKeys.every((key, index) => key === previous.comparisonSelectedSeriesKeys[index]) &&
      next.selectedSeriesIds.length === previous.selectedSeriesIds.length &&
      next.selectedSeriesIds.every((id, index) => id === previous.selectedSeriesIds[index])
    ) return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const analysisWorkspaceStore = new AnalysisWorkspaceStore();
export function resetAnalysisWorkspaceForTests(): void { analysisWorkspaceStore.reset(); }
