import { describe, expect, it } from "vitest";

import {
  normalAxisForPlane,
  positionFractionFromCoordinate,
  resolvedAxisCoordinate,
} from "./defaultPlanarSourceModel";

const bounds = {
  min: [10, 20, 30] as const,
  max: [14, 26, 42] as const,
};

describe("default planar source model", () => {
  it.each([
    ["xy", "z", 36],
    ["xz", "y", 23],
    ["yz", "x", 12],
  ] as const)("resolves the normal coordinate for %s", (plane, axis, expected) => {
    expect(normalAxisForPlane(plane)).toBe(axis);
    expect(resolvedAxisCoordinate(bounds, plane, 0.5)).toBe(expected);
  });

  it("clamps fraction and coordinate at the physical domain bounds", () => {
    expect(resolvedAxisCoordinate(bounds, "xy", -1)).toBe(30);
    expect(resolvedAxisCoordinate(bounds, "xy", 2)).toBe(42);
    expect(positionFractionFromCoordinate(bounds, "xy", 0)).toBe(0);
    expect(positionFractionFromCoordinate(bounds, "xy", 100)).toBe(1);
  });

  it("round-trips a resolved SI coordinate without assuming an origin at zero", () => {
    const coordinate = resolvedAxisCoordinate(bounds, "yz", 0.25);
    expect(coordinate).toBe(11);
    expect(positionFractionFromCoordinate(bounds, "yz", coordinate)).toBe(0.25);
  });
});
