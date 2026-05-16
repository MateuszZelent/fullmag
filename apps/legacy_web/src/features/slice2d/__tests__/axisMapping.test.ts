import { describe, expect, it } from "vitest";

import {
  formatWorldPosition,
  percentFromWorldPosition,
  positionPercentFromSliceIndex,
  planeFromSliceAxis,
  resolveEffectiveSlicePlane,
  resolveSliceAxisSelection,
  sliceAxisBoundsFromMesh,
  sliceAxisMagneticExtent,
  sliceIndexFromPositionPercent,
  sliceAxisFromPlane,
  worldPositionFromPercent,
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

  it("round-trips physical positions through normalized percent", () => {
    const world = worldPositionFromPercent(10e-9, 30e-9, 25);
    expect(world).toBe(15e-9);
    expect(percentFromWorldPosition(10e-9, 30e-9, world)).toBeCloseTo(25, 12);
  });

  it("computes full axis bounds from mesh nodes", () => {
    const nodes = new Float64Array([
      0, 1e-9, 2e-9,
      5e-9, 7e-9, 11e-9,
      -3e-9, 13e-9, 17e-9,
    ]);
    expect(sliceAxisBoundsFromMesh(nodes, 3, "x")).toEqual({ min: -3e-9, max: 5e-9 });
    expect(sliceAxisBoundsFromMesh(nodes, 3, "z")).toEqual({ min: 2e-9, max: 17e-9 });
  });

  it("computes magnetic extent from visible tetrahedra", () => {
    const nodes = new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 2, 0,
      0, 0, 3,
      10, 0, 0,
      12, 0, 0,
      10, 4, 0,
      10, 0, 6,
    ]);
    const elements = new Int32Array([
      0, 1, 2, 3,
      4, 5, 6, 7,
    ]);
    const visibleElements = new Uint8Array([0, 1]);
    expect(sliceAxisMagneticExtent(nodes, 8, "x", visibleElements, elements)).toEqual({
      min: 10,
      max: 12,
    });
  });

  it("formats physical coordinates in micromagnetic units", () => {
    expect(formatWorldPosition(25e-9)).toBe("25.000 nm");
    expect(formatWorldPosition(1.5e-6)).toBe("1.500 um");
  });
});
