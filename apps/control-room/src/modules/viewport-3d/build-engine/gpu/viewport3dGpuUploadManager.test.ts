import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticRecordFromViewport3DGpuUploadDiagnostic,
  subscribeViewport3DGpuUploadDiagnostics,
} from "./viewport3dGpuUploadDiagnostics";
import { createViewport3DGpuUploadManager } from "./viewport3dGpuUploadManager";

describe("viewport3dGpuUploadManager", () => {
  it("exports max per-frame upload time rather than ticket wall time", () => {
    const record = createDiagnosticRecordFromViewport3DGpuUploadDiagnostic({
      aborted: false,
      budgetExceeded: true,
      completedAtMs: 250,
      error: null,
      key: "vector-glyph-upload",
      kind: "viewport-3d-gpu-upload",
      lane: "vector-glyph",
      mainUploadMs: 120,
      maxChunkMs: 4,
      maxFrameUploadMs: 18,
      queuedAtMs: 100,
      targetRevision: "field=f1",
      status: "ready",
      totalWallMs: 150,
      uploadBytes: 2048,
      uploadChunks: 8,
      uploadFrames: 6,
    });

    expect(record).toMatchObject({
      buildLane: "vector-glyph-upload",
      durationMs: 18,
      mainUploadMs: 18,
      severity: "warning",
    });
    expect(record.detail).toMatchObject({
      totalMainUploadMs: 120,
      totalWallMs: 150,
    });
  });

  it("splits upload chunks across frame-budgeted slices before adopting visible handles", () => {
    let nowMs = 0;
    const scheduled: Array<() => void> = [];
    const uploaded: number[] = [];
    const adopted: string[] = [];
    const diagnostics: unknown[] = [];
    const manager = createViewport3DGpuUploadManager({
      now: () => nowMs,
      onDiagnosticRecord: (record) => diagnostics.push(record),
      policy: {
        maxBytesPerSlice: 1024,
        maxFrameBudgetMs: 2,
        maxItemsPerSlice: 1024,
        targetFrameBudgetMs: 2,
      },
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });

    manager.enqueue({
      chunks: [0, 1, 2, 3, 4].map((index) => ({
        estimatedBytes: 16,
        itemCount: 1,
        upload: () => {
          uploaded.push(index);
          nowMs += 1;
        },
      })),
      estimatedBytes: 80,
      key: "vector:glyphs",
      lane: "vector-glyph",
      onVisible: () => adopted.push("visible"),
      targetRevision: "field=f1",
    });

    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(uploaded).toEqual([0, 1]);
    expect(adopted).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(uploaded).toEqual([0, 1, 2, 3]);
    expect(adopted).toEqual([]);

    scheduled.shift()?.();
    expect(uploaded).toEqual([0, 1, 2, 3, 4]);
    expect(adopted).toEqual(["visible"]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        key: "vector:glyphs",
        kind: "viewport-3d-gpu-upload",
        lane: "vector-glyph",
        mainUploadMs: 5,
        targetRevision: "field=f1",
        uploadBytes: 80,
        uploadChunks: 5,
        uploadFrames: 3,
      }),
    ]);
  });

  it("shares one frame budget across independent manager instances", () => {
    let nowMs = 0;
    const scheduled: Array<() => void> = [];
    const uploaded: string[] = [];
    const adopted: string[] = [];
    const createManager = () =>
      createViewport3DGpuUploadManager({
        now: () => nowMs,
        policy: {
          maxBytesPerSlice: 1024,
          maxFrameBudgetMs: 2,
          maxItemsPerSlice: 1024,
          targetFrameBudgetMs: 2,
        },
        scheduleFrame: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancelFrame: () => {},
      });
    const firstManager = createManager();
    const secondManager = createManager();

    firstManager.enqueue({
      chunks: [
        {
          estimatedBytes: 16,
          itemCount: 1,
          upload: () => {
            uploaded.push("first");
            nowMs += 2;
          },
        },
      ],
      estimatedBytes: 16,
      key: "first-upload",
      lane: "field-color",
      onVisible: () => adopted.push("first"),
      targetRevision: "field=f1",
    });
    secondManager.enqueue({
      chunks: [
        {
          estimatedBytes: 16,
          itemCount: 1,
          upload: () => {
            uploaded.push("second");
            nowMs += 2;
          },
        },
      ],
      estimatedBytes: 16,
      key: "second-upload",
      lane: "vector-glyph",
      onVisible: () => adopted.push("second"),
      targetRevision: "field=f1",
    });

    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(uploaded).toEqual(["first"]);
    expect(adopted).toEqual(["first"]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(uploaded).toEqual(["first", "second"]);
    expect(adopted).toEqual(["first", "second"]);
  });

  it("records each ticket upload time without charging prior managers in the shared frame", () => {
    let nowMs = 0;
    const scheduled: Array<() => void> = [];
    const diagnostics: unknown[] = [];
    const createManager = () =>
      createViewport3DGpuUploadManager({
        now: () => nowMs,
        onDiagnosticRecord: (record) => diagnostics.push(record),
        policy: {
          maxBytesPerSlice: 1024,
          maxFrameBudgetMs: 3,
          maxItemsPerSlice: 1024,
          targetFrameBudgetMs: 3,
        },
        scheduleFrame: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancelFrame: () => {},
      });
    const firstManager = createManager();
    const secondManager = createManager();

    firstManager.enqueue({
      chunks: [
        {
          estimatedBytes: 16,
          itemCount: 1,
          upload: () => {
            nowMs += 1;
          },
        },
      ],
      estimatedBytes: 16,
      key: "first-upload",
      lane: "field-color",
      onVisible: () => {},
      targetRevision: "field=f1",
    });
    secondManager.enqueue({
      chunks: [
        {
          estimatedBytes: 16,
          itemCount: 1,
          upload: () => {
            nowMs += 1;
          },
        },
      ],
      estimatedBytes: 16,
      key: "second-upload",
      lane: "vector-glyph",
      onVisible: () => {},
      targetRevision: "field=f1",
    });

    scheduled.shift()?.();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        key: "first-upload",
        mainUploadMs: 1,
        maxFrameUploadMs: 1,
      }),
      expect.objectContaining({
        key: "second-upload",
        mainUploadMs: 1,
        maxFrameUploadMs: 1,
      }),
    ]);
  });

  it("aborts obsolete tickets before mutating visible state", () => {
    const scheduled: Array<() => void> = [];
    const uploaded: string[] = [];
    const adopted: string[] = [];
    const diagnostics: unknown[] = [];
    const abortController = new AbortController();
    const manager = createViewport3DGpuUploadManager({
      onDiagnosticRecord: (record) => diagnostics.push(record),
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });

    manager.enqueue({
      chunks: [
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => uploaded.push("chunk"),
        },
      ],
      estimatedBytes: 8,
      key: "obsolete",
      lane: "vector-glyph",
      onVisible: () => adopted.push("visible"),
      signal: abortController.signal,
      targetRevision: "field=f2",
    });
    abortController.abort();
    scheduled.shift()?.();

    expect(uploaded).toEqual([]);
    expect(adopted).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        aborted: true,
        key: "obsolete",
        uploadChunks: 0,
        uploadFrames: 0,
      }),
    ]);
  });

  it("aborts obsolete tickets after partial upload before visible adoption", () => {
    let nowMs = 0;
    const scheduled: Array<() => void> = [];
    const uploaded: number[] = [];
    const adopted: string[] = [];
    const diagnostics: unknown[] = [];
    const manager = createViewport3DGpuUploadManager({
      now: () => nowMs,
      onDiagnosticRecord: (record) => diagnostics.push(record),
      policy: {
        maxBytesPerSlice: 1024,
        maxFrameBudgetMs: 1,
        maxItemsPerSlice: 1024,
        targetFrameBudgetMs: 1,
      },
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });

    manager.enqueue({
      chunks: [0, 1, 2].map((index) => ({
        estimatedBytes: 16,
        itemCount: 1,
        upload: () => {
          uploaded.push(index);
          nowMs += 1;
        },
      })),
      estimatedBytes: 48,
      key: "vector-glyph:field=f1:target=v1",
      lane: "vector-glyph",
      onVisible: () => adopted.push("visible"),
      targetRevision: "target=v1",
    });

    scheduled.shift()?.();
    expect(uploaded).toEqual([0]);
    expect(adopted).toEqual([]);

    expect(manager.abort("vector-glyph:field=f1:target=v1")).toBe(true);
    scheduled.shift()?.();

    expect(uploaded).toEqual([0]);
    expect(adopted).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        aborted: true,
        key: "vector-glyph:field=f1:target=v1",
        targetRevision: "target=v1",
        uploadChunks: 1,
        uploadFrames: 1,
      }),
    ]);
  });

  it("fails one ticket without blocking another manager and rolls back uploaded chunks", () => {
    const scheduled: Array<() => void> = [];
    const diagnostics: unknown[] = [];
    const rolledBack: string[] = [];
    const uploaded: string[] = [];
    const firstManager = createViewport3DGpuUploadManager({
      onDiagnosticRecord: (record) => diagnostics.push(record),
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });
    const secondManager = createViewport3DGpuUploadManager({
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });
    const signal = new AbortController().signal;
    const removeAbortListener = vi.spyOn(signal, "removeEventListener");

    firstManager.enqueue({
      chunks: [
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => uploaded.push("first-complete"),
          rollback: () => rolledBack.push("first-complete"),
        },
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => {
            uploaded.push("first-throws");
            throw new Error("upload failed");
          },
          rollback: () => rolledBack.push("first-throws"),
        },
      ],
      estimatedBytes: 16,
      key: "failed-upload",
      lane: "field-color",
      onVisible: () => uploaded.push("should-not-be-visible"),
      signal,
      targetRevision: "field=f1",
    });
    secondManager.enqueue({
      chunks: [
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => uploaded.push("second-complete"),
        },
      ],
      estimatedBytes: 8,
      key: "second-upload",
      lane: "vector-glyph",
      onVisible: () => uploaded.push("second-visible"),
      targetRevision: "field=f1",
    });

    scheduled.shift()?.();

    expect(uploaded).toEqual([
      "first-complete",
      "first-throws",
      "second-complete",
      "second-visible",
    ]);
    expect(rolledBack).toEqual(["first-complete", "first-throws"]);
    expect(removeAbortListener).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        aborted: false,
        error: "upload failed",
        key: "failed-upload",
        lane: "field-color",
        status: "failed",
        uploadChunks: 1,
      }),
    ]);
  });

  it("fails an onVisible callback without retaining the ticket or blocking the next ticket", () => {
    const scheduled: Array<() => void> = [];
    const diagnostics: unknown[] = [];
    const rolledBack: string[] = [];
    const visible: string[] = [];
    const manager = createViewport3DGpuUploadManager({
      onDiagnosticRecord: (record) => diagnostics.push(record),
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });

    manager.enqueue({
      chunks: [
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => {},
          rollback: () => rolledBack.push("failed-visible"),
        },
      ],
      estimatedBytes: 8,
      key: "failed-visible",
      lane: "region-overlay",
      onVisible: () => {
        throw new Error("visibility failed");
      },
      targetRevision: "topology=t1",
    });
    manager.enqueue({
      chunks: [
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => {},
        },
      ],
      estimatedBytes: 8,
      key: "after-visible-failure",
      lane: "region-overlay",
      onVisible: () => visible.push("next"),
      targetRevision: "topology=t1",
    });

    scheduled.shift()?.();
    scheduled.shift()?.();

    expect(visible).toEqual(["next"]);
    expect(rolledBack).toEqual(["failed-visible"]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        error: "visibility failed",
        key: "failed-visible",
        status: "failed",
      }),
      expect.objectContaining({
        key: "after-visible-failure",
        status: "ready",
      }),
    ]);
  });

  it("still publishes a failed diagnostic when a local diagnostic callback throws", () => {
    const scheduled: Array<() => void> = [];
    const published: unknown[] = [];
    const unsubscribe = subscribeViewport3DGpuUploadDiagnostics((record) => {
      if (record.key === "failed-with-throwing-observer") {
        published.push(record);
      }
    });
    const manager = createViewport3DGpuUploadManager({
      onDiagnosticRecord: () => {
        throw new Error("local diagnostics failed");
      },
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });

    manager.enqueue({
      chunks: [
        {
          estimatedBytes: 8,
          itemCount: 1,
          upload: () => {
            throw new Error("upload failed");
          },
        },
      ],
      estimatedBytes: 8,
      key: "failed-with-throwing-observer",
      lane: "field-color",
      onVisible: () => {},
      targetRevision: "field=f1",
    });

    scheduled.shift()?.();
    unsubscribe();

    expect(published).toEqual([
      expect.objectContaining({
        error: "upload failed",
        status: "failed",
      }),
    ]);
  });
});
