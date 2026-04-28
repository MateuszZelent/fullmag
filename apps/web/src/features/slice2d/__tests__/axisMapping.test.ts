import { describe, expect, it } from "vitest";

import {
  positionPercentFromSliceIndex,
  planeFromSliceAxis,
  resolveEffectiveSlicePlane,
  resolveSliceAxisSelection,
  sliceIndexFromPositionPercent,
  sliceAxisFromPlane,
} from "../axisMapping";

describe("slice2d axis mapping", () => {
  it("maps toolbar axes to slice planes", () => {
    expect(planeFromSliceAxis("x")).toBe("yz");
    expect(planeFromSliceAxis("y")).toBe("xz");
    expect(planeFromSliceAxis("z")).toBe("xy");
  });

  it("maps slice planes back to toolbar axes", () => {
    expect(sliceAxisFromPlane("yz")).toBe("x");
    expect(sliceAxisFromPlane("xz")).toBe("y");
    expect(sliceAxisFromPlane("xy")).toBe("z");
  });

  it("synchronizes clip axis for FEM slice selection", () => {
    expect(resolveSliceAxisSelection({ axis: "y", syncClipAxis: true })).toEqual({
      plane: "xz",
      clipAxis: "y",
    });
  });

  it("leaves clip axis untouched for non-FEM slice selection", () => {
    expect(resolveSliceAxisSelection({ axis: "z", syncClipAxis: false })).toEqual({
      plane: "xy",
      clipAxis: null,
    });
  });

  it("maps slice position percent to the correct layer index", () => {
    expect(
      sliceIndexFromPositionPercent({
        grid: [11, 21, 31],
        plane: "xy",
        positionPercent: 50,
      }),
    ).toBe(15);
    expect(
      sliceIndexFromPositionPercent({
        grid: [11, 21, 31],
        plane: "yz",
        positionPercent: 50,
      }),
    ).toBe(5);
  });

  it("maps slice layer index back to normalized percent", () => {
    expect(
      positionPercentFromSliceIndex({
        grid: [11, 21, 31],
        plane: "xy",
        sliceIndex: 15,
      }),
    ).toBe(50);
    expect(
      positionPercentFromSliceIndex({
        grid: [11, 21, 31],
        plane: "yz",
        sliceIndex: 5,
      }),
    ).toBe(50);
  });

  it("prefers clip-axis-derived plane when requested", () => {
    expect(
      resolveEffectiveSlicePlane({
        plane: "xy",
        clipAxis: "y",
        preferClipAxis: true,
      }),
    ).toBe("xz");
    expect(
      resolveEffectiveSlicePlane({
        plane: "xy",
        clipAxis: "y",
        preferClipAxis: false,
      }),
    ).toBe("xy");
  });
});
