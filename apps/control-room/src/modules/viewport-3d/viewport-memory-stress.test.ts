import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "@/kernel/resources/ResourceCache";

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
