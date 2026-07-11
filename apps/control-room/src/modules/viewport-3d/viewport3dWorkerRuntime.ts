"use client";

import { useEffect } from "react";

import {
  disposeViewport3DRegionOverlayBuildWorker,
  getViewport3DRegionOverlayPendingJobCount,
  getViewport3DRegionOverlayWorkerRuntimeCounts,
} from "./region-overlays/viewport3dRegionOverlayBuildScheduler";
import {
  disposeViewport3DTopologyIndexWorker,
  getViewport3DTopologyIndexPendingJobCount,
  getViewport3DTopologyIndexWorkerRuntimeCounts,
} from "./viewport3dTopologyIndexScheduler";
import {
  disposeViewport3DColorTransformWorker,
  getViewport3DColorTransformPendingJobCount,
  getViewport3DColorTransformWorkerRuntimeCounts,
} from "./viewport3dColorTransformScheduler";
import {
  disposeVectorGlyphBuildWorker,
  getVectorGlyphPendingJobCount,
  getVectorGlyphWorkerRuntimeCounts,
} from "./layers/vectorGlyphBuildScheduler";
import {
  disposeViewport3DFdmCuboidBuildWorker,
  getViewport3DFdmCuboidPendingJobCount,
  getViewport3DFdmCuboidWorkerRuntimeCounts,
} from "./layers/fdmCuboidBuildScheduler";

export interface Viewport3DWorkerRuntimeLane {
  readonly dispose: () => void;
  readonly getCounts?: () => { timers: number; workers: number };
  readonly getPendingJobCount?: () => number;
  readonly id: string;
}

export interface Viewport3DWorkerRuntimeSnapshot {
  readonly activeLeases: number;
  readonly disposed: boolean;
  readonly jobs: number;
  readonly timers: number;
  readonly workers: number;
}

export interface Viewport3DWorkerRuntimeLease {
  readonly release: () => void;
}

export interface Viewport3DWorkerRuntime {
  readonly acquire: () => Viewport3DWorkerRuntimeLease;
  readonly getSnapshot: () => Viewport3DWorkerRuntimeSnapshot;
}

const WORKER_RUNTIME_LANES: readonly Viewport3DWorkerRuntimeLane[] = [
  {
    dispose: disposeViewport3DTopologyIndexWorker,
    getCounts: getViewport3DTopologyIndexWorkerRuntimeCounts,
    getPendingJobCount: getViewport3DTopologyIndexPendingJobCount,
    id: "topology-index",
  },
  {
    dispose: disposeViewport3DColorTransformWorker,
    getCounts: getViewport3DColorTransformWorkerRuntimeCounts,
    getPendingJobCount: getViewport3DColorTransformPendingJobCount,
    id: "field-color",
  },
  {
    dispose: disposeViewport3DRegionOverlayBuildWorker,
    getCounts: getViewport3DRegionOverlayWorkerRuntimeCounts,
    getPendingJobCount: getViewport3DRegionOverlayPendingJobCount,
    id: "region-overlay",
  },
  {
    dispose: disposeVectorGlyphBuildWorker,
    getCounts: getVectorGlyphWorkerRuntimeCounts,
    getPendingJobCount: getVectorGlyphPendingJobCount,
    id: "vector-glyph",
  },
  {
    dispose: disposeViewport3DFdmCuboidBuildWorker,
    getCounts: getViewport3DFdmCuboidWorkerRuntimeCounts,
    getPendingJobCount: getViewport3DFdmCuboidPendingJobCount,
    id: "fdm-cuboid",
  },
];

let sharedRuntime: Viewport3DWorkerRuntime | null = null;

export function createViewport3DWorkerRuntime(
  lanes: readonly Viewport3DWorkerRuntimeLane[],
): Viewport3DWorkerRuntime {
  let activeLeases = 0;
  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const lane of lanes) lane.dispose();
  }

  return {
    acquire(): Viewport3DWorkerRuntimeLease {
      if (disposed) {
        throw new Error("Viewport 3D worker runtime has been disposed.");
      }
      activeLeases += 1;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          activeLeases = Math.max(activeLeases - 1, 0);
          if (activeLeases === 0) dispose();
        },
      };
    },
    getSnapshot(): Viewport3DWorkerRuntimeSnapshot {
      const laneCounts = lanes.map((lane) => lane.getCounts?.() ?? { timers: 0, workers: 0 });
      return {
        activeLeases,
        disposed,
        jobs: lanes.reduce((total, lane) => total + (lane.getPendingJobCount?.() ?? 0), 0),
        timers: laneCounts.reduce((total, counts) => total + counts.timers, 0),
        workers: laneCounts.reduce((total, counts) => total + counts.workers, 0),
      };
    },
  };
}

export function acquireViewport3DWorkerRuntime(): Viewport3DWorkerRuntimeLease {
  if (!sharedRuntime || sharedRuntime.getSnapshot().disposed) {
    sharedRuntime = createViewport3DWorkerRuntime(WORKER_RUNTIME_LANES);
  }
  return sharedRuntime.acquire();
}

/** Own the module-scoped worker clients for exactly one mounted 3D viewport. */
export function useViewport3DWorkerRuntime(
  onSnapshot?: (snapshot: Viewport3DWorkerRuntimeSnapshot) => void,
): void {
  useEffect(() => {
    const lease = acquireViewport3DWorkerRuntime();
    onSnapshot?.(getViewport3DWorkerRuntimeSnapshot());
    return () => {
      lease.release();
      onSnapshot?.(getViewport3DWorkerRuntimeSnapshot());
    };
  }, [onSnapshot]);
}

export function getViewport3DWorkerRuntimeSnapshot(): Viewport3DWorkerRuntimeSnapshot {
  return (
    sharedRuntime?.getSnapshot() ?? {
      activeLeases: 0,
      disposed: true,
      jobs: 0,
      timers: 0,
      workers: 0,
    }
  );
}
