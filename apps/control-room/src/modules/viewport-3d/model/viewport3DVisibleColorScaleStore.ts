import {
  updateVisibleColorScales,
  type Viewport3DVisibleColorScaleReport,
  type Viewport3DVisibleColorScales,
} from "./viewport3DVisibleColorScale";

export interface Viewport3DVisibleColorScaleStore {
  getSnapshot(): Viewport3DVisibleColorScales;
  report(report: Viewport3DVisibleColorScaleReport): void;
  subscribe(listener: () => void): () => void;
}

export function createViewport3DVisibleColorScaleStore(
  scopeKey: string | null,
): Viewport3DVisibleColorScaleStore {
  let snapshot: Viewport3DVisibleColorScales = { scopeKey, passes: {} };
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    report(report) {
      const next = updateVisibleColorScales(snapshot, report);
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
