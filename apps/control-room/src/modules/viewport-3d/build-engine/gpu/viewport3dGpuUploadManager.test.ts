import { describe, expect, it } from "vitest";

import { createViewport3DGpuUploadManager } from "./viewport3dGpuUploadManager";

describe("viewport3dGpuUploadManager", () => {
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
});
