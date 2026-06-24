import type {
  DiagnosticViewport3DWorkerPoolRecord,
} from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";

import type { Viewport3DWorkerPoolSnapshot } from "./viewport3dWorkerPoolTypes";

export interface Viewport3DWorkerPoolDiagnosticRecord
  extends Viewport3DWorkerPoolSnapshot {
  readonly kind: "viewport-3d-worker-pool";
  readonly poolId: string;
}

export interface Viewport3DWorkerPoolDiagnosticsSnapshot {
  readonly activeJobs: number;
  readonly maxWorkers: number;
  readonly pools: readonly Viewport3DWorkerPoolDiagnosticRecord[];
  readonly workerCount: number;
}

type Viewport3DWorkerPoolDiagnosticListener = (
  record: Viewport3DWorkerPoolDiagnosticRecord,
) => void;

const listeners = new Set<Viewport3DWorkerPoolDiagnosticListener>();
const records = new Map<string, Viewport3DWorkerPoolDiagnosticRecord>();

export function createViewport3DWorkerPoolDiagnosticRecord(
  poolId: string,
  snapshot: Viewport3DWorkerPoolSnapshot,
): Viewport3DWorkerPoolDiagnosticRecord {
  return {
    ...snapshot,
    kind: "viewport-3d-worker-pool",
    poolId,
  };
}

export function createDiagnosticRecordFromViewport3DWorkerPoolDiagnostic(
  record: Viewport3DWorkerPoolDiagnosticRecord,
): DiagnosticViewport3DWorkerPoolRecord {
  return {
    activeJobs: record.activeJobs,
    byteLength: null,
    detail: {
      activeJobs: record.activeJobs,
      maxWorkers: record.maxWorkers,
      poolId: record.poolId,
      workerCount: record.workerCount,
    },
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "viewport-3d-worker-pool",
    lane: "worker",
    maxWorkers: record.maxWorkers,
    name: `fullmag.viewport3d.worker-pool.${record.poolId}`,
    poolId: record.poolId,
    severity: "info",
    startTimeMs: null,
    timestampMs: Date.now(),
    workerCount: record.workerCount,
  };
}

export function recordViewport3DWorkerPoolDiagnostic(
  record: Viewport3DWorkerPoolDiagnosticRecord,
): void {
  records.set(record.poolId, record);
  for (const listener of listeners) {
    listener(record);
  }
}

export function subscribeViewport3DWorkerPoolDiagnostics(
  listener: Viewport3DWorkerPoolDiagnosticListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getViewport3DWorkerPoolDiagnosticsSnapshot():
  Viewport3DWorkerPoolDiagnosticsSnapshot {
  const pools = Array.from(records.values()).sort((left, right) =>
    left.poolId.localeCompare(right.poolId),
  );
  return {
    activeJobs: pools.reduce((total, pool) => total + pool.activeJobs, 0),
    maxWorkers: pools.reduce((total, pool) => total + pool.maxWorkers, 0),
    pools,
    workerCount: pools.reduce((total, pool) => total + pool.workerCount, 0),
  };
}

export function clearViewport3DWorkerPoolDiagnosticsForTests(): void {
  records.clear();
  listeners.clear();
}
