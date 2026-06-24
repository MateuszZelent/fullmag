import type {
  Viewport3DBuildEngineSnapshot,
  Viewport3DBuildJobKey,
  Viewport3DBuildJobSnapshot,
} from "./viewport3dBuildEngineTypes";

export interface Viewport3DBuildEngineStore {
  getSnapshot: () => Viewport3DBuildEngineSnapshot;
  publishJobState: (job: Viewport3DBuildJobSnapshot) => void;
  subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_BUILD_ENGINE_SNAPSHOT: Viewport3DBuildEngineSnapshot = {
  jobs: [],
};

export function createViewport3DBuildEngineStore(): Viewport3DBuildEngineStore {
  const jobsByKey = new Map<Viewport3DBuildJobKey, Viewport3DBuildJobSnapshot>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_BUILD_ENGINE_SNAPSHOT;

  function publishJobState(job: Viewport3DBuildJobSnapshot): void {
    const previous = jobsByKey.get(job.key);
    if (previous && areJobSnapshotsEqual(previous, job)) {
      return;
    }

    jobsByKey.set(job.key, job);
    snapshot = {
      jobs: Array.from(jobsByKey.values()).sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
    };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot: () => snapshot,
    publishJobState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function areJobSnapshotsEqual(
  left: Viewport3DBuildJobSnapshot,
  right: Viewport3DBuildJobSnapshot,
): boolean {
  return (
    left.itemCount === right.itemCount &&
    left.key === right.key &&
    left.lane === right.lane &&
    left.revisionSummary === right.revisionSummary &&
    left.state === right.state
  );
}

