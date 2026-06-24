import type {
  Viewport3DWorkerPool,
  Viewport3DWorkerPoolLease,
  Viewport3DWorkerPoolOptions,
  Viewport3DWorkerPoolSnapshot,
  Viewport3DWorkerPoolWorker,
} from "./viewport3dWorkerPoolTypes";

export type {
  Viewport3DWorkerPool,
  Viewport3DWorkerPoolLease,
  Viewport3DWorkerPoolOptions,
  Viewport3DWorkerPoolSnapshot,
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
  const maxWorkers = Math.max(1, Math.floor(options.maxWorkers));
  const slots: WorkerPoolSlot<TWorker>[] = [];
  let disposed = false;

  function acquire(): Viewport3DWorkerPoolLease<TWorker> {
    if (disposed) {
      throw new Error("Viewport 3D worker pool has been disposed.");
    }
    const slot = acquireSlot();
    slot.activeJobs += 1;
    let released = false;

    return {
      worker: slot.worker,
      release: () => {
        if (released) return;
        released = true;
        slot.activeJobs = Math.max(slot.activeJobs - 1, 0);
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
      return slot;
    }
    return slots.reduce((leastBusy, slot) =>
      slot.activeJobs < leastBusy.activeJobs ? slot : leastBusy,
    );
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const slot of slots) {
      slot.activeJobs = 0;
      slot.worker.terminate();
    }
    slots.length = 0;
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
}
