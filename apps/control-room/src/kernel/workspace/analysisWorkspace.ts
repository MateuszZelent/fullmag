import type { AnalysisSurface } from "./analysisViewPreferences";

export interface AnalysisWorkspaceState {
  activeSurface: AnalysisSurface;
  selectedDatasetRef: string | null;
}

const INITIAL_STATE: AnalysisWorkspaceState = { activeSurface: "dynamics", selectedDatasetRef: null };
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
  setActiveSurface(activeSurface: AnalysisSurface): void { this.update({ ...this.state, activeSurface }); }
  setSelectedDatasetRef(selectedDatasetRef: string | null): void {
    const valid = typeof selectedDatasetRef === "string" && selectedDatasetRef.length > 0 && selectedDatasetRef.length <= MAX_DATASET_REF_LENGTH
      ? selectedDatasetRef
      : null;
    this.update({ ...this.state, selectedDatasetRef: valid });
  }
  reset(): void { this.update(INITIAL_STATE); }
  private update(next: AnalysisWorkspaceState): void {
    if (next.activeSurface === this.state.activeSurface && next.selectedDatasetRef === this.state.selectedDatasetRef) return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const analysisWorkspaceStore = new AnalysisWorkspaceStore();
export function resetAnalysisWorkspaceForTests(): void { analysisWorkspaceStore.reset(); }
