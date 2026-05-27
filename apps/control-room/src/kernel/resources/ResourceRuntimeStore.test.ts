import { describe, expect, it, vi } from "vitest";

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
});
