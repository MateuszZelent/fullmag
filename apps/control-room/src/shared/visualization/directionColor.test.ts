import { describe, expect, it } from "vitest";

import { DIRECTION_HSL_NEUTRAL_RGB, directionHslSrgb, isDirectionColormap } from "./directionColor";

describe("mumax3 direction colormap", () => {
  it("maps world axes like mumax3 HSLMap", () => {
    expect(directionHslSrgb(1, 0, 0)).toEqual([1, 0, 0]);
    expect(directionHslSrgb(-1, 0, 0)).toEqual([0, 1, 1]);
    expect(directionHslSrgb(0, 0, 1)).toEqual([1, 1, 1]);
    expect(directionHslSrgb(0, 0, -1)).toEqual([0, 0, 0]);
  });

  it("depends only on direction, not on amplitude or unit", () => {
    expect(directionHslSrgb(3e5, 4e5, 0)).toEqual(directionHslSrgb(0.6, 0.8, 0));
  });

  it("maps vectors without a direction to neutral grey instead of NaN", () => {
    expect(directionHslSrgb(0, 0, 0)).toEqual([...DIRECTION_HSL_NEUTRAL_RGB]);
    expect(directionHslSrgb(Number.NaN, 0, 0)).toEqual([...DIRECTION_HSL_NEUTRAL_RGB]);
  });

  it("recognises the planar direction colormap id", () => {
    expect(isDirectionColormap("hsl_direction")).toBe(true);
    expect(isDirectionColormap("viridis")).toBe(false);
  });
});
