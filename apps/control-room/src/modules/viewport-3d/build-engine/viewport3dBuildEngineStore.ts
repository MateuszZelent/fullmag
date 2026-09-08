import type {
  Viewport3DBuildFallbackSnapshot,
  Viewport3DBuildFallbackStateInput,
  Viewport3DBuildEngineSnapshot,
  Viewport3DBuildJobKey,
  Viewport3DBuildJobSnapshot,
  Viewport3DBuildLane,
  Viewport3DBuildState,
} from "./viewport3dBuildEngineTypes";

export interface Viewport3DBuildEngineStore {
  getSnapshot: () => Viewport3DBuildEngineSnapshot;
  publishFallbackState: (fallback: Viewport3DBuildFallbackStateInput) => void;
  publishJobState: (job: Viewport3DBuildJobSnapshot) => void;
  subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_BUILD_ENGINE_SNAPSHOT: Viewport3DBuildEngineSnapshot = {
  fallbacks: [],
  jobs: [],
};

// jobsByKey is keyed on more than just an object identity — the key embeds
// fieldRevision/topologyRevision/styleRevision, so the key space is
// unbounded and grows with every simulation frame. Without evicting
// terminal (finished) jobs the map and the sorted snapshot it rebuilds on
// every publish grow linearly for the life of the viewport (M-09).
const VIEWPORT_3D_BUILD_ENGINE_TERMINAL_RETENTION_MS = 5_000;
const VIEWPORT_3D_BUILD_ENGINE_MAX_TERMINAL_JOBS = 64;

function isTerminalViewport3DBuildJobState(
  state: Viewport3DBuildState,
): boolean {
  // Deliberately NOT `state !== "queued" && state !== "running"` — this
  // vocabulary also has "transferring" and "uploading", which are in-flight,
  // not finished. Evicting those would drop a job the UI is still tracking.
  return (
    state === "ready" ||
    state === "failed" ||
    state === "aborted" ||
    state === "stale"
  );
}

export function createViewport3DBuildEngineStore(): Viewport3DBuildEngineStore {
  const fallbacksByLane = new Map<
    Viewport3DBuildLane,
    Viewport3DBuildFallbackSnapshot
  >();
  const jobsByKey = new Map<Viewport3DBuildJobKey, Viewport3DBuildJobSnapshot>();
  const terminalOrder: Viewport3DBuildJobKey[] = [];
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_BUILD_ENGINE_SNAPSHOT;

  function scheduleTerminalEviction(key: Viewport3DBuildJobKey): void {
    setTimeout(() => {
      const current = jobsByKey.get(key);
      if (!current || !isTerminalViewport3DBuildJobState(current.state)) {
        return;
      }
      jobsByKey.delete(key);
      const orderIndex = terminalOrder.indexOf(key);
      if (orderIndex >= 0) terminalOrder.splice(orderIndex, 1);
      rebuildSnapshotAndNotify();
    }, VIEWPORT_3D_BUILD_ENGINE_TERMINAL_RETENTION_MS);
  }

  function publishJobState(job: Viewport3DBuildJobSnapshot): void {
    const previous = jobsByKey.get(job.key);
    if (previous && areJobSnapshotsEqual(previous, job)) {
      return;
    }

    jobsByKey.set(job.key, job);
    if (isTerminalViewport3DBuildJobState(job.state)) {
      terminalOrder.push(job.key);
      scheduleTerminalEviction(job.key);
      // Hard LRU cap as a backstop: if the retention timer somehow can't
      // keep up (fake timers in tests, a stalled event loop), the map must
      // still not grow without bound.
      while (terminalOrder.length > VIEWPORT_3D_BUILD_ENGINE_MAX_TERMINAL_JOBS) {
        const oldest = terminalOrder.shift();
        if (oldest !== undefined) jobsByKey.delete(oldest);
      }
    }
    rebuildSnapshotAndNotify();
  }

  function publishFallbackState(
    fallback: Viewport3DBuildFallbackStateInput,
  ): void {
    const previous = fallbacksByLane.get(fallback.lane);
    fallbacksByLane.set(fallback.lane, {
      ...fallback,
      count: (previous?.count ?? 0) + 1,
    });
    rebuildSnapshotAndNotify();
  }

  return {
    getSnapshot: () => snapshot,
    publishFallbackState,
    publishJobState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  function rebuildSnapshotAndNotify(): void {
    snapshot = {
      fallbacks: Array.from(fallbacksByLane.values()).sort((left, right) =>
        left.lane.localeCompare(right.lane),
      ),
      jobs: Array.from(jobsByKey.values()).sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
    };
    for (const listener of listeners) {
      listener();
    }
  }
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
