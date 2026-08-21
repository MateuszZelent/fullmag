import { describe, expect, it } from "vitest";

import {
  createViewport3DBatchedInvalidator,
  VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT,
} from "./viewport3dBatchedInvalidate";

describe("createViewport3DBatchedInvalidator", () => {
  it("coalesces typed reasons into one demand frame and fails closed on overflow", () => {
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

    const overflow = createViewport3DBatchedInvalidator({
      invalidate: (reasons) => invalidations.push([...reasons]),
      maxReasons: 1,
      schedule: () => undefined,
    });
    expect(overflow.invalidate("camera")).toBe(true);
    expect(overflow.invalidate("field-buffer")).toBe(false);
    expect(overflow.getSnapshot()).toEqual({
      overflowed: true,
      reasons: ["camera"],
    });
    expect(VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT).toBeGreaterThan(0);
  });
});
