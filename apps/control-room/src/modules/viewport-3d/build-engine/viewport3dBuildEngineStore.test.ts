import { describe, expect, it, vi } from "vitest";

import { createViewport3DBuildEngineStore } from "./viewport3dBuildEngineStore";

describe("viewport3dBuildEngineStore", () => {
  it("keeps snapshots referentially stable when a job state is unchanged", () => {
    const store = createViewport3DBuildEngineStore();

    const initial = store.getSnapshot();
    store.publishJobState({
      itemCount: 128,
      key: "vector-glyph:field-1",
      lane: "vector-glyph",
      revisionSummary: "topology-1 field-1",
      state: "queued",
    });
    const queued = store.getSnapshot();

    store.publishJobState({
      itemCount: 128,
      key: "vector-glyph:field-1",
      lane: "vector-glyph",
      revisionSummary: "topology-1 field-1",
      state: "queued",
    });

    expect(store.getSnapshot()).toBe(queued);
    expect(queued).not.toBe(initial);
  });

  it("notifies subscribers once for a changed small status snapshot", () => {
    const store = createViewport3DBuildEngineStore();
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    store.publishJobState({
      itemCount: 1,
      key: "topology-index:topology-1",
      lane: "topology-index",
      revisionSummary: "topology-1",
      state: "running",
    });
    store.publishJobState({
      itemCount: 1,
      key: "topology-index:topology-1",
      lane: "topology-index",
      revisionSummary: "topology-1",
      state: "running",
    });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().jobs).toEqual([
      {
        itemCount: 1,
        key: "topology-index:topology-1",
        lane: "topology-index",
        revisionSummary: "topology-1",
        state: "running",
      },
    ]);
  });

  it("exposes small worker fallback snapshots per lane", () => {
    const store = createViewport3DBuildEngineStore();
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    store.publishFallbackState({
      key: "vector-glyph:field-1",
      lane: "vector-glyph",
      reason: "worker-unavailable",
      revisionSummary: "topology-1 field-1",
      timestampMs: 42,
    });
    store.publishFallbackState({
      key: "vector-glyph:field-2",
      lane: "vector-glyph",
      reason: "worker-unavailable",
      revisionSummary: "topology-1 field-2",
      timestampMs: 84,
    });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().fallbacks).toEqual([
      {
        count: 2,
        key: "vector-glyph:field-2",
        lane: "vector-glyph",
        reason: "worker-unavailable",
        revisionSummary: "topology-1 field-2",
        timestampMs: 84,
      },
    ]);
  });

  describe("M-09 · bounded jobsByKey", () => {
    it("evicts a terminal job after the retention window", () => {
      vi.useFakeTimers();
      try {
        const store = createViewport3DBuildEngineStore();
        store.publishJobState({
          itemCount: 1,
          key: "vector-glyph:k1",
          lane: "vector-glyph",
          revisionSummary: "r1",
          state: "ready",
        });
        expect(store.getSnapshot().jobs).toHaveLength(1);

        vi.advanceTimersByTime(6_000);

        expect(store.getSnapshot().jobs).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not evict jobs that are still queued or running", () => {
      vi.useFakeTimers();
      try {
        const store = createViewport3DBuildEngineStore();
        store.publishJobState({
          itemCount: 1,
          key: "vector-glyph:k1",
          lane: "vector-glyph",
          revisionSummary: "r1",
          state: "running",
        });

        vi.advanceTimersByTime(60_000);

        expect(store.getSnapshot().jobs).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not evict in-flight transferring/uploading states", () => {
      vi.useFakeTimers();
      try {
        const store = createViewport3DBuildEngineStore();
        for (const state of ["transferring", "uploading"] as const) {
          store.publishJobState({
            itemCount: 1,
            key: `vector-glyph:${state}`,
            lane: "vector-glyph",
            revisionSummary: "r1",
            state,
          });
        }

        vi.advanceTimersByTime(60_000);

        expect(store.getSnapshot().jobs).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("caps terminal jobs with a hard LRU limit even without the retention timer firing", () => {
      const store = createViewport3DBuildEngineStore();
      for (let index = 0; index < 200; index += 1) {
        store.publishJobState({
          itemCount: 1,
          key: `vector-glyph:k${index}`,
          lane: "vector-glyph",
          revisionSummary: `r${index}`,
          state: "ready",
        });
      }

      expect(store.getSnapshot().jobs.length).toBeLessThanOrEqual(64);
    });
  });
});
