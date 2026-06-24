import { describe, expect, it, vi } from "vitest";

import { createViewport3DWorkerPool } from "./viewport3dWorkerPool";
import {
  clearViewport3DWorkerPoolDiagnosticsForTests,
  getViewport3DWorkerPoolDiagnosticsSnapshot,
  subscribeViewport3DWorkerPoolDiagnostics,
} from "./viewport3dWorkerPoolDiagnostics";

class TestWorker {
  readonly id: number;
  terminate = vi.fn();

  constructor(id: number) {
    this.id = id;
  }
}

describe("viewport3dWorkerPool", () => {
  it("publishes bounded worker pool status snapshots without polling", () => {
    clearViewport3DWorkerPoolDiagnosticsForTests();
    const listener = vi.fn();
    const unsubscribe = subscribeViewport3DWorkerPoolDiagnostics(listener);
    let nextWorkerId = 1;
    const pool = createViewport3DWorkerPool({
      createWorker: () => new TestWorker(nextWorkerId++),
      maxWorkers: 2,
      poolId: "vector-glyph",
    });

    const first = pool.acquire();
    const second = pool.acquire();
    first.release();
    pool.dispose();
    second.release();
    unsubscribe();

    expect(listener).toHaveBeenCalled();
    expect(getViewport3DWorkerPoolDiagnosticsSnapshot()).toEqual({
      activeJobs: 0,
      maxWorkers: 2,
      pools: [
        expect.objectContaining({
          activeJobs: 0,
          maxWorkers: 2,
          poolId: "vector-glyph",
          workerCount: 0,
        }),
      ],
      workerCount: 0,
    });
  });

  it("creates workers up to the configured maximum and then reuses the least busy worker", () => {
    let nextWorkerId = 1;
    const pool = createViewport3DWorkerPool({
      createWorker: () => new TestWorker(nextWorkerId++),
      maxWorkers: 2,
    });

    const first = pool.acquire();
    const second = pool.acquire();
    const third = pool.acquire();

    expect(pool.snapshot()).toEqual({
      activeJobs: 3,
      maxWorkers: 2,
      workerCount: 2,
    });
    expect(first.worker.id).toBe(1);
    expect(second.worker.id).toBe(2);
    expect(third.worker.id).toBe(1);

    first.release();
    second.release();
    third.release();
    expect(pool.snapshot().activeJobs).toBe(0);

    pool.dispose();
  });

  it("terminates every worker when disposed", () => {
    let nextWorkerId = 1;
    const pool = createViewport3DWorkerPool({
      createWorker: () => new TestWorker(nextWorkerId++),
      maxWorkers: 2,
    });

    const first = pool.acquire();
    const second = pool.acquire();
    pool.dispose();
    first.release();
    second.release();

    expect(first.worker.terminate).toHaveBeenCalledTimes(1);
    expect(second.worker.terminate).toHaveBeenCalledTimes(1);
    expect(pool.snapshot()).toEqual({
      activeJobs: 0,
      maxWorkers: 2,
      workerCount: 0,
    });
  });

  it("terminates idle workers after the configured idle timeout", async () => {
    vi.useFakeTimers();
    try {
      let nextWorkerId = 1;
      const onWorkerTerminated = vi.fn();
      const pool = createViewport3DWorkerPool({
        createWorker: () => new TestWorker(nextWorkerId++),
        idleTimeoutMs: 250,
        maxWorkers: 2,
        onWorkerTerminated,
      });

      const first = pool.acquire();
      const second = pool.acquire();
      first.release();

      await vi.advanceTimersByTimeAsync(249);

      expect(first.worker.terminate).not.toHaveBeenCalled();
      expect(second.worker.terminate).not.toHaveBeenCalled();
      expect(pool.snapshot()).toEqual({
        activeJobs: 1,
        maxWorkers: 2,
        workerCount: 2,
      });

      second.release();
      await vi.advanceTimersByTimeAsync(250);

      expect(first.worker.terminate).toHaveBeenCalledTimes(1);
      expect(second.worker.terminate).toHaveBeenCalledTimes(1);
      expect(onWorkerTerminated).toHaveBeenCalledTimes(2);
      expect(onWorkerTerminated).toHaveBeenNthCalledWith(1, first.worker);
      expect(onWorkerTerminated).toHaveBeenNthCalledWith(2, second.worker);
      expect(pool.snapshot()).toEqual({
        activeJobs: 0,
        maxWorkers: 2,
        workerCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
