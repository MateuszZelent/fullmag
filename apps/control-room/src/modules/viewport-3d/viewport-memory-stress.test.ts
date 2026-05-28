import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "@/kernel/resources/ResourceCache";
import { ResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";

import { Viewport3DResourceTracker } from "./viewport3dDiagnostics";

describe("viewport 3D memory stress", () => {
  it("bounds decoded field cache growth across repeated quantity switches", () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });

    for (let index = 0; index < 100; index += 1) {
      cache.set(`field:${index}`, {
        byteLength: 8,
        data: `quantity-${index}`,
      });
    }

    expect(cache.stats()).toEqual({ byteLength: 32, entryCount: 4 });
    expect(cache.get("field:99")?.data).toBe("quantity-99");
    expect(cache.get("field:0")).toBeNull();
  });

  it("releases inactive decoded field buffers across repeated quantity switches", async () => {
    const store = new ResourceRuntimeStore<{ values: Float32Array }>();
    let allocatedBytes = 0;

    for (let index = 0; index < 200; index += 1) {
      const resourceKey = `data/fields/q${index}/samples/vector`;
      const unsubscribe = store.subscribe(resourceKey, () => undefined);
      const values = new Float32Array(4096);
      allocatedBytes += values.byteLength;

      await store.ensureLoad({
        externalRevision: index,
        load: async () => ({ values }),
        resourceKey,
        resolveRevision: () => index,
      });

      expect(store.getSnapshot(resourceKey)).toMatchObject({
        data: { values },
        revision: index,
        status: "ready",
      });

      unsubscribe();
      expect(store.stats()).toEqual({
        entryCount: 0,
        inflightCount: 0,
        listenerCount: 0,
        pendingRequestCount: 0,
        readyCount: 0,
      });
    }

    expect(allocatedBytes).toBeGreaterThan(0);
  });

  it("releases viewport-owned resources after repeated mount cycles", () => {
    const tracker = new Viewport3DResourceTracker();
    const disposeFns = Array.from({ length: 20 }, () => vi.fn());

    disposeFns.forEach((dispose, index) => {
      tracker.track("geometry", { dispose, id: index });
    });

    tracker.disposeAll();

    expect(tracker.getSnapshot().geometries).toBe(0);
    expect(disposeFns.every((dispose) => dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
