/** Read-only UI identity. Run resources and numerical arrays stay in resource hooks. */
export interface SavedRunSelection {
  readonly projectId: string;
  readonly runId: string;
  readonly apiScope: string;
}

export class SavedRunController {
  private selection: SavedRunSelection | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.selection;
  getServerSnapshot = () => null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  beginOpen() { return ++this.generation; }
  openVerified(selection: SavedRunSelection, generation: number) {
    if (generation !== this.generation) throw new Error("Saved run selection changed while opening.");
    this.selection = Object.freeze({ ...selection });
    this.listeners.forEach(listener => listener());
  }
  close() {
    ++this.generation;
    this.selection = null;
    this.listeners.forEach(listener => listener());
  }
}

export function savedResultScopeMatches(scope: { projectId: string | null; runId: string | null }, selection: { projectId: string; runId: string } | null): boolean {
  return selection !== null && scope.projectId === selection.projectId
    && (scope.runId === null || scope.runId === selection.runId);
}
