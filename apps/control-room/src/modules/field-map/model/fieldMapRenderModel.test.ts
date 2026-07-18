import { describe, expect, it } from "vitest";

import {
  resolvePlanarVectorComponents,
  surfaceProjectionStatus,
} from "./fieldMapRenderModel";

describe("field-map render model", () => {
  it.each([
    ["xy", [1, 0, 0], [0, 1, 0], [0, 0, 1], [2, 3, 4], [2, 3, 4]],
    ["xz", [1, 0, 0], [0, 0, 1], [0, -1, 0], [2, 3, 4], [2, 4, -3]],
    ["yz", [0, 1, 0], [0, 0, 1], [1, 0, 0], [2, 3, 4], [3, 4, 2]],
  ])("projects world vectors into the %s monitor basis", (
    _name,
    uAxis,
    vAxis,
    normal,
    vector,
    expected,
  ) => {
    const result = resolvePlanarVectorComponents(
      vector as [number, number, number],
      {
        normal: normal as [number, number, number],
        uAxis: uAxis as [number, number, number],
        vAxis: vAxis as [number, number, number],
      },
    );
    expect([result.u, result.v, result.normal]).toEqual(expected);
  });

  it("supports arbitrary orthonormal frames and stable zero vectors", () => {
    const inverseSqrt2 = 1 / Math.sqrt(2);
    const projected = resolvePlanarVectorComponents([1, 1, 0], {
        normal: [0, 0, 1],
        uAxis: [inverseSqrt2, inverseSqrt2, 0],
        vAxis: [-inverseSqrt2, inverseSqrt2, 0],
      });
    expect(projected.u).toBeCloseTo(Math.sqrt(2));
    expect(projected).toMatchObject({ normal: 0, v: 0 });
    expect(
      resolvePlanarVectorComponents([1e-20, 0, 0], {
        normal: [0, 0, 1],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
      }),
    ).toEqual({ magnitude: 0, normal: 0, u: 0, v: 0 });
  });

  it("surfaces overlap and fold ambiguity explicitly", () => {
    expect(
      surfaceProjectionStatus({
        fold_count: 1,
        non_injective: true,
        overlap_count: 2,
      }),
    ).toBe("ambiguous");
  });
});
