import { describe, expect, it } from "vitest";

import {
  buildFieldMapRenderModel,
  resolveFieldMapAuxiliaryDiagnostics,
  resolvePlanarDisplayRange,
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

  it("reports auxiliary failures without suppressing the scalar layer", () => {
    expect(
      resolveFieldMapAuxiliaryDiagnostics([
        {
          errorMessage: "mask 422",
          hasData: false,
          label: "Occupancy mask",
          requested: true,
          status: "error",
        },
        {
          errorMessage: null,
          hasData: true,
          label: "Vector overlay",
          requested: true,
          status: "stale",
        },
        {
          errorMessage: null,
          hasData: false,
          label: "Mesh overlay",
          requested: true,
          status: "ready",
        },
        {
          errorMessage: null,
          hasData: true,
          label: "Scalar field",
          requested: false,
          status: "ready",
        },
      ]),
    ).toEqual([
      "Occupancy mask: degraded — mask 422.",
      "Vector overlay: stale — the last revision is not current.",
      "Mesh overlay: not materialized for this scope.",
    ]);
  });

  it("builds one immutable renderer input without changing canonical values or sample identity", () => {
    const scalar = new Float64Array([1_000, 2_000]);
    const model = buildFieldMapRenderModel({
      bounds: [2, 6, -4, 4],
      canonicalUnit: "A/m",
      component: "normal",
      displayUnit: "kA/m",
      frame: {
        normal: [0, 0, 1],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
      },
      layers: { contours: false, mesh: false, raster: true, vectors: false },
      range: { mode: "manual", max: 2_000, min: 1_000 },
      resolution: [2, 1],
      sampleIdentity: '"fm-planar-sha256:sample"',
      scalar,
    });

    expect(model.scalar).toBe(scalar);
    expect(model.sampleIdentity).toBe('"fm-planar-sha256:sample"');
    expect(model.display).toMatchObject({
      axisUnit: "m",
      legendUnit: "kA/m",
      probeScale: 1 / 1_000,
    });
    expect(model.range).toEqual({ max: 2_000, min: 1_000 });
    expect(model.boundsCenter).toEqual([4, 0]);
  });

  it("resolves deterministic auto, manual, and symmetric ranges while ignoring masks and non-finite values", () => {
    const values = new Float64Array([Number.NaN, -4, 2, 9]);
    const mask = new Uint8Array([1, 0, 0, 1]);

    expect(resolvePlanarDisplayRange(values, mask, { mode: "auto" })).toEqual({
      max: 2,
      min: -4,
    });
    expect(resolvePlanarDisplayRange(values, mask, { mode: "manual", min: -3, max: 7 })).toEqual({
      max: 7,
      min: -3,
    });
    expect(resolvePlanarDisplayRange(values, mask, { mode: "symmetric" })).toEqual({
      max: 4,
      min: -4,
    });
    expect(resolvePlanarDisplayRange(new Float64Array([5, 5]), undefined, { mode: "auto" })).toEqual({
      max: 5.5,
      min: 4.5,
    });
  });
});
