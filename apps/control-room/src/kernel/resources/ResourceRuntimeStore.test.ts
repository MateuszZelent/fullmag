import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELD_VECTOR_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";

import { ResourceRuntimeStore } from "./ResourceRuntimeStore";

function deferred<TData>(): {
  promise: Promise<TData>;
  reject: (reason?: unknown) => void;
  resolve: (value: TData) => void;
} {
  let resolve!: (value: TData) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TData>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("ResourceRuntimeStore", () => {
  const magnetizationVectorResourceKey = DATA_FIELD_VECTOR_PATH.replace(
    "{quantity_id}",
    "m",
  );

  it("returns a stable initial snapshot for missing resource keys", () => {
    const store = new ResourceRuntimeStore<string>();

    expect(store.getSnapshot("session:status")).toBe(
      store.getSnapshot("session:status"),
    );
  });

  it("deduplicates concurrent loads for the same resource key and revision", async () => {
    const store = new ResourceRuntimeStore<string>();
    const load = vi.fn(async () => "ready");

    const [first, second] = await Promise.all([
      store.ensureLoad({
        externalRevision: 1,
        load,
        resourceKey: "model/scene",
        resolveRevision: () => 1,
      }),
      store.ensureLoad({
        externalRevision: 1,
        load,
        resourceKey: "model/scene",
        resolveRevision: () => 1,
      }),
    ]);

    expect(first.data).toBe("ready");
    expect(second.data).toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot("model/scene")).toMatchObject({
      data: "ready",
      revision: 1,
      status: "ready",
    });
  });

  it("does not reload a settled resource for the same external revision", async () => {
    const store = new ResourceRuntimeStore<string>();
    const load = vi.fn(async () => "ready");

    await store.ensureLoad({
      externalRevision: 1,
      load,
      resourceKey: "visualization/state",
      resolveRevision: () => 1,
    });
    await store.ensureLoad({
      externalRevision: 1,
      load,
      resourceKey: "visualization/state",
      resolveRevision: () => 1,
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated forced loads while the same revision is already in flight", async () => {
    const store = new ResourceRuntimeStore<string>();
    const first = deferred<string>();
    const signals: AbortSignal[] = [];
    const load = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return first.promise;
    });

    const firstResult = store.ensureLoad({
      externalRevision: 1,
      force: true,
      load,
      resourceKey: "analysis/topological-charge",
      resolveRevision: () => 1,
    });
    const secondResult = store.ensureLoad({
      externalRevision: 1,
      force: true,
      load,
      resourceKey: "analysis/topological-charge",
      resolveRevision: () => 1,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    first.resolve("ready");
    await Promise.all([firstResult, secondResult]);

    expect(store.getSnapshot("analysis/topological-charge")).toMatchObject({
      data: "ready",
      revision: 1,
      status: "ready",
    });
  });

  it("keeps warm quantity resources without refetching when switching back", async () => {
    const store = new ResourceRuntimeStore<string>();
    const loadM = vi.fn(async () => "m-data");
    const loadH = vi.fn(async () => "h-data");

    await store.ensureLoad({
      externalRevision: null,
      load: loadM,
      resourceKey: "data/fields/m/samples/vector?component=full&scope_kind=full",
      resolveRevision: () => '"m-etag"',
    });
    await store.ensureLoad({
      externalRevision: null,
      load: loadH,
      resourceKey: "data/fields/h_eff/samples/vector?component=full&scope_kind=full",
      resolveRevision: () => '"h-etag"',
    });
    await store.ensureLoad({
      externalRevision: null,
      load: loadM,
      resourceKey: "data/fields/m/samples/vector?component=full&scope_kind=full",
      resolveRevision: () => '"m-etag"',
    });

    expect(loadM).toHaveBeenCalledTimes(1);
    expect(loadH).toHaveBeenCalledTimes(1);
    expect(
      store.getSnapshot(
        "data/fields/m/samples/vector?component=full&scope_kind=full",
      ),
    ).toMatchObject({
      data: "m-data",
      revision: '"m-etag"',
      status: "ready",
    });
  });

  it("queues the latest revision without aborting the active resource load", async () => {
    const store = new ResourceRuntimeStore<string>();
    const first = deferred<string>();
    const latest = deferred<string>();
    const signals: AbortSignal[] = [];
    const firstLoad = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return first.promise;
    });
    const skippedLoad = vi.fn(async () => "skipped");
    const latestLoad = vi.fn(() => latest.promise);

    const firstResult = store.ensureLoad({
      externalRevision: 1,
      load: firstLoad,
      resourceKey: "data/fields/m",
      resolveRevision: () => 1,
    });
    store.ensureLoad({
      externalRevision: 2,
      load: skippedLoad,
      resourceKey: "data/fields/m",
      resolveRevision: () => 2,
    });
    store.ensureLoad({
      externalRevision: 3,
      load: latestLoad,
      resourceKey: "data/fields/m",
      resolveRevision: () => 3,
    });

    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(skippedLoad).not.toHaveBeenCalled();
    expect(latestLoad).not.toHaveBeenCalled();
    expect(signals[0]?.aborted).toBe(false);

    first.resolve("old");
    await firstResult;
    await Promise.resolve();

    expect(skippedLoad).not.toHaveBeenCalled();
    expect(latestLoad).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    latest.resolve("new");
    await store.ensureLoad({
      externalRevision: 3,
      load: latestLoad,
      resourceKey: "data/fields/m",
      resolveRevision: () => 3,
    });

    expect(latestLoad).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot("data/fields/m")).toMatchObject({
      data: "new",
      revision: 3,
      status: "ready",
    });
  });

  it("aborts stale in-flight loads when latest-only mode is requested", async () => {
    const store = new ResourceRuntimeStore<string>();
    const first = deferred<string>();
    const latest = deferred<string>();
    const signals: AbortSignal[] = [];
    const firstLoad = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return first.promise;
    });
    const latestLoad = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return latest.promise;
    });

    void store.ensureLoad({
      abortStaleInflight: true,
      externalRevision: 1,
      load: firstLoad,
      resourceKey: "data/fields/m",
      resolveRevision: () => 1,
    });
    const latestResult = store.ensureLoad({
      abortStaleInflight: true,
      externalRevision: 2,
      load: latestLoad,
      resourceKey: "data/fields/m",
      resolveRevision: () => 2,
    });

    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(latestLoad).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    first.resolve("old");
    latest.resolve("new");
    await latestResult;

    expect(store.getSnapshot("data/fields/m")).toMatchObject({
      data: "new",
      revision: 2,
      status: "ready",
    });
  });

  it("aborts an active load when a resource is paused", async () => {
    const store = new ResourceRuntimeStore<string>();
    const first = deferred<string>();
    const signals: AbortSignal[] = [];
    const load = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return first.promise;
    });

    void store.ensureLoad({
      externalRevision: 1,
      load,
      resourceKey: "data/fields/m/samples/vector",
      resolveRevision: () => 1,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    store.pauseLoad("data/fields/m/samples/vector");

    expect(signals[0]?.aborted).toBe(true);
    expect(store.getSnapshot("data/fields/m/samples/vector").status).toBe(
      "loading",
    );
  });

  it("aborts matching active loads without touching unrelated resources", async () => {
    const store = new ResourceRuntimeStore<string>();
    const field = deferred<string>();
    const visualization = deferred<string>();
    const fieldSignals: AbortSignal[] = [];
    const visualizationSignals: AbortSignal[] = [];

    void store.ensureLoad({
      externalRevision: 1,
      load: ({ signal }) => {
        fieldSignals.push(signal);
        return field.promise;
      },
      resourceKey: magnetizationVectorResourceKey,
      resolveRevision: () => 1,
    });
    void store.ensureLoad({
      externalRevision: 1,
      load: ({ signal }) => {
        visualizationSignals.push(signal);
        return visualization.promise;
      },
      resourceKey: VISUALIZATION_STATE_PATH,
      resolveRevision: () => 1,
    });

    expect(fieldSignals[0]?.aborted).toBe(false);
    expect(visualizationSignals[0]?.aborted).toBe(false);

    store.pauseMatching((resourceKey) =>
      resourceKey.includes("/data/fields/") &&
      resourceKey.includes("/samples/vector"),
    );

    expect(fieldSignals[0]?.aborted).toBe(true);
    expect(visualizationSignals[0]?.aborted).toBe(false);
  });

  it("pauses new matching loads until the matching pause is released", async () => {
    const store = new ResourceRuntimeStore<string>();
    const load = vi.fn(async () => "field");
    const release = store.beginPauseMatching((resourceKey) =>
      resourceKey.includes("/data/fields/"),
    );

    await store.ensureLoad({
      externalRevision: 1,
      load,
      resourceKey: magnetizationVectorResourceKey,
      resolveRevision: () => 1,
    });

    expect(load).not.toHaveBeenCalled();

    release();
    await store.ensureLoad({
      externalRevision: 1,
      load,
      resourceKey: magnetizationVectorResourceKey,
      resolveRevision: () => 1,
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("delays heavy refetches until the minimum interval elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const store = new ResourceRuntimeStore<string>();
      const loadInitial = vi.fn(async () => "initial");
      const loadLatest = vi.fn(async () => "latest");

      await store.ensureLoad({
        externalRevision: 1,
        load: loadInitial,
        minRefetchIntervalMs: 250,
        resourceKey: "data/fields/m",
        resolveRevision: () => 1,
      });

      vi.setSystemTime(1_020);
      await store.ensureLoad({
        externalRevision: 2,
        load: loadLatest,
        minRefetchIntervalMs: 250,
        resourceKey: "data/fields/m",
        resolveRevision: () => 2,
      });

      expect(loadInitial).toHaveBeenCalledTimes(1);
      expect(loadLatest).not.toHaveBeenCalled();
      expect(store.getSnapshot("data/fields/m")).toMatchObject({
        data: "initial",
        revision: 2,
        status: "stale",
      });

      await vi.advanceTimersByTimeAsync(229);
      expect(loadLatest).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();

      expect(loadLatest).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot("data/fields/m")).toMatchObject({
        data: "latest",
        revision: 2,
        status: "ready",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps newer locally seeded data when an older in-flight load resolves", async () => {
    const store = new ResourceRuntimeStore<string>();
    const stale = deferred<string>();
    const staleLoad = vi.fn(() => stale.promise);

    const staleResult = store.ensureLoad({
      externalRevision: 10,
      load: staleLoad,
      resourceKey: "visualization/state",
      resolveRevision: () => 10,
    });

    store.updateData("visualization/state", "fresh-camera", 11);
    stale.resolve("stale-camera");
    await staleResult;

    expect(store.getSnapshot("visualization/state")).toMatchObject({
      data: "fresh-camera",
      revision: 11,
      status: "ready",
    });
  });

  it("releases unobserved resource snapshots after the last subscriber leaves", async () => {
    const store = new ResourceRuntimeStore<{ buffer: ArrayBuffer }>();
    const unsubscribe = store.subscribe("data/fields/m", () => undefined);
    const data = { buffer: new ArrayBuffer(1024) };

    await store.ensureLoad({
      externalRevision: 1,
      load: async () => data,
      resourceKey: "data/fields/m",
      resolveRevision: () => 1,
    });

    expect(store.getSnapshot("data/fields/m")).toMatchObject({
      data,
      revision: 1,
      status: "ready",
    });
    expect(store.stats()).toMatchObject({
      entryCount: 1,
      listenerCount: 1,
      readyCount: 1,
    });
    expect(store.listenerCounts()).toEqual({ "data/fields/m": 1 });

    unsubscribe();

    expect(store.getSnapshot("data/fields/m")).toMatchObject({
      data: null,
      revision: null,
      status: "loading",
    });
    expect(store.stats()).toEqual({
      entryCount: 0,
      inflightCount: 0,
      listenerCount: 0,
      pendingRequestCount: 0,
      readyCount: 0,
    });
    expect(store.listenerCounts()).toEqual({});
  });

  it("aborts an in-flight load when the last subscriber leaves", async () => {
    const store = new ResourceRuntimeStore<string>();
    const pending = deferred<string>();
    const signals: AbortSignal[] = [];
    const unsubscribe = store.subscribe("data/fields/m", () => undefined);

    void store.ensureLoad({
      externalRevision: 1,
      load: ({ signal: requestSignal }) => {
        signals.push(requestSignal);
        return pending.promise;
      },
      resourceKey: "data/fields/m",
      resolveRevision: () => 1,
    });

    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(false);

    unsubscribe();

    expect(signals[0]?.aborted).toBe(true);
    expect(store.stats()).toEqual({
      entryCount: 0,
      inflightCount: 0,
      listenerCount: 0,
      pendingRequestCount: 0,
      readyCount: 0,
    });
  });
});
