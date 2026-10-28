export interface SavedResultsPlaybackSelection {
  itemId: string;
  name: string;
  stageId: string | null;
  frameIndex: number;
  component: 0 | 1 | 2;
  colorLimit: number | null;
}

/** UI selection only. Numerical buffers belong to resource hooks, never this controller. */
export class SavedResultsPlaybackController {
  private selection: SavedResultsPlaybackSelection | null = null;
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.selection;
  getServerSnapshot = () => null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  open(source: Pick<SavedResultsPlaybackSelection, "itemId" | "name">) {
    if (!source.itemId || !source.name) throw new Error("A saved result folder is required.");
    this.publish({ ...source, stageId: null, frameIndex: 0, component: 2, colorLimit: null });
  }
  close() { this.publish(null); }
  selectFrame(frameIndex: number) {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return;
    this.patch({ frameIndex });
  }
  selectStage(stageId: string) { if (stageId) this.patch({ stageId, frameIndex: 0 }); }
  setComponent(component: 0 | 1 | 2) { if ([0, 1, 2].includes(component)) this.patch({ component }); }
  setColorLimit(colorLimit: number | null) {
    if (colorLimit !== null && (!Number.isFinite(colorLimit) || colorLimit <= 0)) return;
    this.patch({ colorLimit });
  }
  private patch(patch: Partial<SavedResultsPlaybackSelection>) {
    if (this.selection) this.publish({ ...this.selection, ...patch });
  }
  private publish(value: SavedResultsPlaybackSelection | null) {
    if (JSON.stringify(this.selection) === JSON.stringify(value)) return;
    this.selection = value;
    this.listeners.forEach(listener => listener());
  }
}
