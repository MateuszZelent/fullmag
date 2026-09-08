import { describe, expect, it } from "vitest";

import {
  createViewport3DBatchedInvalidator,
  VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT,
} from "./viewport3dBatchedInvalidate";
import { VIEWPORT_3D_DIRTY_REASONS } from "./viewport3dTypes";

describe("createViewport3DBatchedInvalidator", () => {
  it("coalesces typed reasons into one demand frame", () => {
    const invalidations: string[][] = [];
    const scheduled = { flush: null as (() => void) | null };
    const invalidator = createViewport3DBatchedInvalidator({
      invalidate: (reasons) => invalidations.push([...reasons]),
      schedule: (nextFlush) => {
        scheduled.flush = nextFlush;
      },
    });

    expect(invalidator.invalidate("camera")).toBe(true);
    expect(invalidator.invalidate("field-buffer")).toBe(true);
    expect(invalidator.invalidate("topology")).toBe(true);
    expect(invalidations).toEqual([]);
    scheduled.flush?.();
    expect(invalidations).toEqual([["camera", "field-buffer", "topology"]]);
  });

  it("emits an emergency frame on overflow instead of latching the loop off", () => {
    const invalidations: string[][] = [];
    const overflow = createViewport3DBatchedInvalidator({
      invalidate: (reasons) => invalidations.push([...reasons]),
      maxReasons: 1,
      schedule: () => undefined,
    });

    expect(overflow.invalidate("camera")).toBe(true);
    expect(overflow.invalidate("field-buffer")).toBe(false);
    // overflow flushed synchronously, both reasons reached the root
    expect(invalidations).toEqual([["camera", "field-buffer"]]);
    // and the invalidator is usable again
    expect(overflow.invalidate("topology")).toBe(true);
    expect(overflow.getSnapshot().overflowed).toBe(false);
  });

  it("sizes the default reason budget to the full dirty-reason vocabulary", () => {
    expect(VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT).toBe(
      VIEWPORT_3D_DIRTY_REASONS.length,
    );
  });
});
