import type {
  Viewport3DWorkerPool,
  Viewport3DWorkerPoolLease,
  Viewport3DWorkerPoolOptions,
  Viewport3DWorkerPoolSnapshot,
  Viewport3DWorkerPoolWorker,
} from "./viewport3dWorkerPoolTypes";
import {
  createViewport3DWorkerPoolDiagnosticRecord,
  recordViewport3DWorkerPoolDiagnostic,
} from "./viewport3dWorkerPoolDiagnostics";

export type {
  Viewport3DWorkerPool,
  Viewport3DWorkerPoolLease,
  Viewport3DWorkerPoolOptions,
  Viewport3DWorkerPoolWorker,
} from "./viewport3dWorkerPoolTypes";

interface WorkerPoolSlot<TWorker extends Viewport3DWorkerPoolWorker> {
  activeJobs: number;
  readonly worker: TWorker;
}

export function createViewport3DWorkerPool<
  TWorker extends Viewport3DWorkerPoolWorker,
>(
  options: Viewport3DWorkerPoolOptions<TWorker>,
): Viewport3DWorkerPool<TWorker> {
  const idleTimeoutMs =
    typeof options.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(options.idleTimeoutMs))
      : null;
  const maxWorkers = Math.max(1, Math.floor(options.maxWorkers));
  const poolId = options.poolId ?? null;
  const slots: WorkerPoolSlot<TWorker>[] = [];
  let disposed = false;
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;

  function acquire(): Viewport3DWorkerPoolLease<TWorker> {
    if (disposed) {
      throw new Error("Viewport 3D worker pool has been disposed.");
    }
    clearIdleTerminationTimer();
    const slot = acquireSlot();
    slot.activeJobs += 1;
    publishSnapshot();
    let released = false;

    return {
      worker: slot.worker,
      release: () => {
        if (released) return;
        released = true;
        slot.activeJobs = Math.max(slot.activeJobs - 1, 0);
        publishSnapshot();
        scheduleIdleTermination();
      },
    };
  }

  function acquireSlot(): WorkerPoolSlot<TWorker> {
    const idleSlot = slots.find((slot) => slot.activeJobs === 0);
    if (idleSlot) return idleSlot;
    if (slots.length < maxWorkers) {
      const slot: WorkerPoolSlot<TWorker> = {
        activeJobs: 0,
        worker: options.createWorker(),
      };
      slots.push(slot);
      publishSnapshot();
      return slot;
    }
    return slots.reduce((leastBusy, slot) =>
      slot.activeJobs < leastBusy.activeJobs ? slot : leastBusy,
    );
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearIdleTerminationTimer();
    for (const slot of slots.splice(0)) {
      slot.activeJobs = 0;
      terminateSlot(slot);
    }
    publishSnapshot();
  }

  function snapshot(): Viewport3DWorkerPoolSnapshot {
    return {
      activeJobs: slots.reduce((total, slot) => total + slot.activeJobs, 0),
      maxWorkers,
      workerCount: slots.length,
    };
  }

  return {
    acquire,
    dispose,
    snapshot,
  };

  function publishSnapshot(): void {
    if (!poolId) return;
    recordViewport3DWorkerPoolDiagnostic(
      createViewport3DWorkerPoolDiagnosticRecord(poolId, snapshot()),
    );
  }

  function scheduleIdleTermination(): void {
    if (
      idleTimeoutMs === null ||
      disposed ||
      idleTimeoutId !== null ||
      snapshot().activeJobs > 0 ||
      slots.length === 0
    ) {
      return;
    }
    idleTimeoutId = setTimeout(() => {
      idleTimeoutId = null;
      terminateIdleSlots();
    }, idleTimeoutMs);
  }

  function clearIdleTerminationTimer(): void {
    if (idleTimeoutId === null) return;
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }

  function terminateIdleSlots(): void {
    if (disposed || snapshot().activeJobs > 0) return;
    for (const slot of slots.splice(0)) {
      terminateSlot(slot);
    }
    publishSnapshot();
  }

  function terminateSlot(slot: WorkerPoolSlot<TWorker>): void {
    slot.worker.terminate();
    options.onWorkerTerminated?.(slot.worker);
  }
}
