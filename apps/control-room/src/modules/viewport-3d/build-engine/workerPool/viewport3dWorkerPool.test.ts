import { describe, expect, it, vi } from "vitest";

import { createViewport3DWorkerPool } from "./viewport3dWorkerPool";

class TestWorker {
  readonly id: number;
  terminate = vi.fn();

  constructor(id: number) {
    this.id = id;
  }
}

describe("viewport3dWorkerPool", () => {
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
});
