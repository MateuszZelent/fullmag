import { describe, expect, it } from "vitest";

import {
  canvasToUv,
  rasterCenterToUv,
  uvToCanvas,
  uvToRasterContinuous,
  uvToRasterIndex,
  viewportToRasterSpace,
} from "./planarViewTransform";

describe("planarViewTransform", () => {
  const bounds = [0, 10, 0, 10] as const;
  const resolution = [2, 2] as const;

  it("rasterCenterToUv computes correct center without W-1 distortion", () => {
    // 2x2 grid: cells are [0, 5] and [5, 10]
    // centers are 2.5 and 7.5
    expect(rasterCenterToUv(0, 0, resolution, bounds)).toEqual([2.5, 2.5]);
    expect(rasterCenterToUv(1, 1, resolution, bounds)).toEqual([7.5, 7.5]);
    expect(rasterCenterToUv(1, 0, resolution, bounds)).toEqual([7.5, 2.5]);
  });

  it("uvToRasterContinuous maps [0, 10] to [0, 2]", () => {
    expect(uvToRasterContinuous(0, 0, resolution, bounds)).toEqual([0, 0]);
    expect(uvToRasterContinuous(5, 5, resolution, bounds)).toEqual([1, 1]);
    expect(uvToRasterContinuous(10, 10, resolution, bounds)).toEqual([2, 2]);
  });

  it("uvToRasterIndex classifies points into discrete cell indices", () => {
    // 2.5 is inside cell (0, 0) -> index 0
    expect(uvToRasterIndex(2.5, 2.5, resolution, bounds)).toEqual({
      col: 0,
      row: 0,
      index: 0,
    });
    // 7.5 is inside cell (1, 1) -> index 3 (row 1 * 2 + col 1)
    expect(uvToRasterIndex(7.5, 7.5, resolution, bounds)).toEqual({
      col: 1,
      row: 1,
      index: 3,
    });
    // outside bounds returns null
    expect(uvToRasterIndex(-1, 5, resolution, bounds)).toBeNull();
    expect(uvToRasterIndex(5, 15, resolution, bounds)).toBeNull();
  });

  it("uvToCanvas and canvasToUv are invertible roundtrip", () => {
    const canvasSize = { width: 800, height: 600 };
    const viewport = [0, 10, 0, 10] as const;

    const [cx, cy] = uvToCanvas(3.5, 7.2, viewport, canvasSize);
    const [u, v] = canvasToUv(cx, cy, viewport, canvasSize);

    expect(u).toBeCloseTo(3.5, 10);
    expect(v).toBeCloseTo(7.2, 10);
  });

  it("resolves C06 (U01): viewportToRasterSpace covers [0, W] and does not scale by W-1", () => {
    // Full bounds viewport:
    const rasterViewport = viewportToRasterSpace(bounds, bounds, resolution);
    // MUST be [0, 2, 0, 2], NOT [0, 1, 0, 1]!
    expect(rasterViewport).toEqual([0, 2, 0, 2]);
    expect(rasterViewport[1]).toBe(2);
    expect(rasterViewport[3]).toBe(2);
  });
});
