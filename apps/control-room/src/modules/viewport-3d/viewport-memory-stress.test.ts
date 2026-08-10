import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "@/kernel/resources/ResourceCache";
import { ResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { compareDiagnosticLeakSnapshots } from "@/kernel/performance/diagnostic-recorder/diagnosticLeakDetector";

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
    const quantityIndices = Array.from({ length: 200 }, (_, index) => index);

    async function runQuantitySwitch(index: number): Promise<void> {
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
        activePauseCount: 0,
        entryCount: 0,
        inflightCount: 0,
        listenerCount: 0,
        pendingRequestCount: 0,
        readyCount: 0,
      });
    }

    // Keep the sequence explicit: each resource must be released before the next switch.
    let sequence = Promise.resolve();
    for (const index of quantityIndices) {
      sequence = sequence.then(() => runQuantitySwitch(index));
    }
    await sequence;

    expect(allocatedBytes).toBeGreaterThan(0);
  }, 15000);

  it("releases viewport-owned resources after repeated mount cycles", () => {
    const tracker = new Viewport3DResourceTracker();
    const disposeFns = Array.from({ length: 20 }, () => vi.fn());

    disposeFns.forEach((dispose, index) => {
      tracker.track("geometry", { dispose, id: index });
    });

    tracker.disposeAll();

    expect(tracker.getSnapshot().geometries).toBe(0);
    expect(
      compareDiagnosticLeakSnapshots(
        {
          activeWorkers: 0,
          dirtyFramesAfterIdle: 0,
          jsHeapUsedBytes: null,
          kind: "before",
          moduleOwnedResourceCount: 0,
          objectUrlCount: 0,
          resourceCacheBytes: 0,
          subscriptionCount: 0,
          timestampMs: 1,
          totalTrackedBytes: 0,
          viewportCacheBytes: 0,
          webglEstimatedBytes: 0,
        },
        {
          activeWorkers: 0,
          dirtyFramesAfterIdle: 0,
          jsHeapUsedBytes: null,
          kind: "after-unmount",
          moduleOwnedResourceCount: tracker.getLedgerSnapshot().length,
          objectUrlCount: 0,
          resourceCacheBytes: 0,
          subscriptionCount: 0,
          timestampMs: 2,
          totalTrackedBytes: 0,
          viewportCacheBytes: 0,
          webglEstimatedBytes: 0,
        },
      ).classification,
    ).toBe("ok");
    expect(disposeFns.every((dispose) => dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
