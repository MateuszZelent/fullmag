import { describe, expect, it } from "vitest";

import {
  MIN_TOOL_DRAG_PX,
  clipUvRect,
  interactionForUvRect,
  measureSegment,
  normalizeUvRect,
  resizeUvRect,
  uvRectLargeEnough,
} from "./planarToolGeometry";

const frame = [0, 4e-8, 0, 2e-8] as const;
const canvas = { width: 400, height: 200 };

describe("planar tool geometry", () => {
  it("fits the full frame with zoom 1 and no pan", () => {
    expect(interactionForUvRect({ u_min_m: 0, u_max_m: 4e-8, v_min_m: 0, v_max_m: 2e-8 }, frame, canvas))
      .toEqual({ panU: 0, panV: 0, zoom: 1 });
  });

  it("zooms 2x on a centred box of half width and height", () => {
    const interaction = interactionForUvRect(
      { u_min_m: 1e-8, u_max_m: 3e-8, v_min_m: 0.5e-8, v_max_m: 1.5e-8 },
      frame,
      canvas,
    );
    expect(interaction.zoom).toBeCloseTo(2, 12);
    expect(interaction.panU).toBeCloseTo(0, 20);
    expect(interaction.panV).toBeCloseTo(0, 20);
  });

  it("fits a box of another aspect ratio completely (the limiting side decides)", () => {
    const rect = { u_min_m: 0, u_max_m: 1e-8, v_min_m: 0, v_max_m: 2e-8 };
    const interaction = interactionForUvRect(rect, frame, canvas);
    expect(interaction.zoom).toBeCloseTo(1, 12);
    expect(interaction.panU).toBeCloseTo(0.5e-8 - 2e-8, 20);
  });

  it("measures a 3-4-5 segment", () => {
    const measured = measureSegment({ u0_m: 0, v0_m: 0, u1_m: 3e-9, v1_m: 4e-9 });
    expect(measured.length_m).toBeCloseTo(5e-9, 20);
    expect(measured.angle_deg).toBeCloseTo(53.13, 2);
    expect(measured.du_m).toBe(3e-9);
    expect(measured.dv_m).toBe(4e-9);
  });

  it("orders the corners whichever way the drag went", () => {
    const expected = { u_min_m: 1, u_max_m: 3, v_min_m: 2, v_max_m: 5 };
    expect(normalizeUvRect({ u_m: 3, v_m: 2 }, { u_m: 1, v_m: 5 })).toEqual(expected);
    expect(normalizeUvRect({ u_m: 1, v_m: 5 }, { u_m: 3, v_m: 2 })).toEqual(expected);
  });

  it("clips a rectangle to the full frame and rejects one outside it", () => {
    expect(clipUvRect({ u_min_m: -1, u_max_m: 1, v_min_m: 0.25, v_max_m: 3 }, [0, 2, 0, 1]))
      .toEqual({ u_min_m: 0, u_max_m: 1, v_min_m: 0.25, v_max_m: 1 });
    expect(clipUvRect({ u_min_m: 3, u_max_m: 4, v_min_m: 0, v_max_m: 1 }, [0, 2, 0, 1])).toBeNull();
  });

  it(`accepts a rectangle only when both screen sides reach ${MIN_TOOL_DRAG_PX} px`, () => {
    const viewport = [0, 400, 0, 200] as const;
    expect(uvRectLargeEnough({ u_min_m: 0, u_max_m: 4, v_min_m: 0, v_max_m: 4 }, viewport, canvas)).toBe(true);
    expect(uvRectLargeEnough({ u_min_m: 0, u_max_m: 3.9, v_min_m: 0, v_max_m: 100 }, viewport, canvas)).toBe(false);
    expect(uvRectLargeEnough({ u_min_m: 0, u_max_m: 100, v_min_m: 0, v_max_m: 3 }, viewport, canvas)).toBe(false);
  });

  it("resizes a crop rectangle from a corner past the opposite edge", () => {
    expect(resizeUvRect({ u_min_m: 0, u_max_m: 2, v_min_m: 0, v_max_m: 2 }, "ne", { u_m: 3, v_m: -1 }))
      .toEqual({ u_min_m: 0, u_max_m: 3, v_min_m: -1, v_max_m: 0 });
  });
});
