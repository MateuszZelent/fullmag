import {
  normalizeViewport3DOrbitDebugAngles,
  shouldApplyViewport3DOrbitDebugAngles,
  type Viewport3DOrbitDebugAngles,
} from "../layers/CameraControls.model";

export interface Viewport3DOrbitDebugSnapshot {
  angles: Viewport3DOrbitDebugAngles;
  commitRevision: number;
  revision: number;
}

export interface Viewport3DOrbitDebugStore {
  applyAngles(angles: Viewport3DOrbitDebugAngles): void;
  commitAngles(): void;
  getSnapshot(): Viewport3DOrbitDebugSnapshot;
  reportAngles(angles: Viewport3DOrbitDebugAngles): void;
  subscribe(listener: () => void): () => void;
}

export function createViewport3DOrbitDebugStore(): Viewport3DOrbitDebugStore {
  let snapshot: Viewport3DOrbitDebugSnapshot = {
    angles: normalizeViewport3DOrbitDebugAngles(null),
    commitRevision: 0,
    revision: 0,
  };
  const listeners = new Set<() => void>();
  const publish = (next: Viewport3DOrbitDebugSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    applyAngles(angles) {
      publish({
        ...snapshot,
        angles: normalizeViewport3DOrbitDebugAngles(angles),
        revision: snapshot.revision + 1,
      });
    },
    commitAngles() {
      publish({ ...snapshot, commitRevision: snapshot.commitRevision + 1 });
    },
    getSnapshot: () => snapshot,
    reportAngles(angles) {
      const nextAngles = normalizeViewport3DOrbitDebugAngles(angles);
      if (!shouldApplyViewport3DOrbitDebugAngles(snapshot.angles, nextAngles)) return;
      publish({ ...snapshot, angles: nextAngles });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
