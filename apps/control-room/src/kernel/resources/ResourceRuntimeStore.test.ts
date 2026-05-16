import { describe, expect, it, vi } from "vitest";

import { ResourceRuntimeStore } from "./ResourceRuntimeStore";

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
});
