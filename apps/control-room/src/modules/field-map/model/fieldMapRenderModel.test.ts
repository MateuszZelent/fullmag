import { describe, expect, it } from "vitest";

import {
  buildFieldMapRenderModel,
  buildPlanarSamplePoints,
  normalizePlanarColorRange,
  resolvePlanarDisplayUnit,
  resolveFieldMapAuxiliaryDiagnostics,
  resolvePlanarDisplayRange,
  resolvePlanarVectorComponents,
  surfaceProjectionStatus,
} from "./fieldMapRenderModel";

describe("field-map render model", () => {
  it("builds a bounded set of occupied evaluation-bin centers without inventing solver nodes", () => {
    const points = buildPlanarSamplePoints(
      [2, 6, -4, 4],
      [4, 2],
      new Uint8Array([0, 1, 2, 3, 4, 0, 1, 0]),
      3,
    );

    expect(points).toEqual([
      { index: 0, u: 2.5, v: -2 },
      { index: 4, u: 2.5, v: 2 },
      { index: 7, u: 5.5, v: 2 },
    ]);
    expect(points).toHaveLength(3);
  });

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
      layers: { bounds: true, contours: false, mesh: false, points: true, raster: true, vectors: false },
      mask: new Uint8Array([0, 0]),
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
    expect(model.boundsOutline).toEqual([2, 6, -4, 4]);
    expect(model.samplePoints).toEqual([
      { index: 0, u: 3, v: 0 },
      { index: 1, u: 5, v: 0 },
    ]);
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
      max: 5,
      min: 5,
    });
    expect(resolvePlanarDisplayRange(new Float64Array([0, 0]), undefined, { mode: "symmetric" })).toEqual({
      max: 0,
      min: 0,
    });
  });

  it("fails closed for an unsupported display unit while converting compatible field units", () => {
    expect(resolvePlanarDisplayUnit("A/m", "MA/m")).toEqual({
      compatible: true,
      scale: 1 / 1_000_000,
      unit: "MA/m",
    });
    expect(resolvePlanarDisplayUnit("T", "mT")).toEqual({
      compatible: true,
      scale: 1_000,
      unit: "mT",
    });
    expect(resolvePlanarDisplayUnit("A/m", "mT")).toEqual({
      compatible: true,
      scale: (4 * Math.PI * 1e-7) * 1_000,
      unit: "mT",
    });
    expect(resolvePlanarDisplayUnit("J/m", "pJ/m")).toEqual({
      compatible: true,
      scale: 1e12,
      unit: "pJ/m",
    });
    expect(resolvePlanarDisplayUnit("1", "1")).toEqual({ compatible: true, scale: 1, unit: "1" });
    expect(resolvePlanarDisplayUnit("Pa", "Pa")).toEqual({ compatible: true, scale: 1, unit: "Pa" });
    expect(resolvePlanarDisplayUnit("rad", "rad")).toEqual({ compatible: true, scale: 1, unit: "rad" });
    expect(resolvePlanarDisplayUnit("Pa", "V")).toEqual({ compatible: false, scale: 1, unit: "Pa" });
    expect(resolvePlanarDisplayUnit("mystery", "mT")).toEqual({ compatible: false, scale: 1, unit: "mystery" });
  });

  it("keeps arbitrary canonical Field Map units identity-compatible without guessing conversions", () => {
    for (const unit of ["m", "Pa", "V", "rad", "dimensionless"]) {
      expect(resolvePlanarDisplayUnit(unit, unit)).toEqual({ compatible: true, scale: 1, unit });
    }
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1],
      canonicalUnit: "Pa",
      component: "normal",
      displayUnit: "Pa",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { contours: false, mesh: false, raster: true, vectors: false },
      range: { mode: "auto" },
      resolution: [1, 1],
      sampleIdentity: "unit-identity",
      scalar: new Float64Array([1]),
    });

    expect(model.display).toMatchObject({ legendUnit: "Pa", probeScale: 1 });
    expect(model.diagnostics).toEqual([]);
  });

  it("keeps unsupported planar presentation semantics visible as fail-closed diagnostics", () => {
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1],
      canonicalUnit: "A/m",
      component: "normal",
      displayUnit: "mT",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { boundaries: true, contours: false, mesh: false, probes: false, raster: false, vectors: false },
      meshOverlayDescriptor: {
        available: false,
        boundaryClassification: "unavailable",
        codec: null,
      },
      range: { mode: "symmetric" },
      resolution: [1, 1],
      sampleIdentity: "sample",
      scalar: new Float64Array([1]),
    });

    expect(model.diagnostics).toEqual(expect.arrayContaining([
      "2D boundaries are unavailable: mesh overlay classification is unavailable or degraded.",
    ]));
    expect(model.range).toEqual({ min: -1, max: 1 });
    expect(model.layers.boundaries).toBe(false);
  });

  it("uses canonical symmetric range and raster opacity without changing scalar samples", () => {
    const scalar = new Float64Array([-4, 2]);
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1],
      canonicalUnit: "A/m",
      component: "normal",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { contours: false, mesh: false, raster: true, vectors: false },
      range: { mode: "symmetric" },
      rasterOpacity: 0.37,
      resolution: [2, 1],
      sampleIdentity: "sample",
      scalar,
    });

    expect(model.range).toEqual({ min: -4, max: 4 });
    expect(model.rasterOpacity).toBe(0.37);
    expect(model.scalar).toBe(scalar);
  });

  it("enables boundaries only for the exact FMCS v4 descriptor", () => {
    const input = {
      bounds: [0, 1, 0, 1] as const,
      canonicalUnit: "A/m",
      component: "normal",
      frame: { normal: [0, 0, 1] as const, uAxis: [1, 0, 0] as const, vAxis: [0, 1, 0] as const },
      layers: { boundaries: true, contours: false, mesh: false, raster: false, vectors: false },
      range: { mode: "auto" as const },
      resolution: [1, 1] as const,
      sampleIdentity: "sample",
      scalar: new Float64Array([1]),
    };
    expect(buildFieldMapRenderModel({
      ...input,
      meshOverlayDescriptor: { available: true, boundaryClassification: "exact", codec: "fmcs.v4" },
    }).layers.boundaries).toBe(true);
    const legacy = buildFieldMapRenderModel({
      ...input,
      meshOverlayDescriptor: { available: true, boundaryClassification: "degraded", codec: "fmcs.v3" },
    });
    expect(legacy.layers.boundaries).toBe(false);
    expect(legacy.diagnostics).toContain("2D boundaries are unavailable: FMCS v3 has no exact target-boundary classes.");
  });

  it("fails closed for nullable manual limits and degraded boundary classifications", () => {
    expect(normalizePlanarColorRange({ mode: "manual", min: null, max: 2 })).toBeNull();
    const degraded = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1],
      canonicalUnit: "A/m",
      component: "normal",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { boundaries: true, contours: false, mesh: false, raster: false, vectors: false },
      meshOverlayDescriptor: { available: true, boundaryClassification: "future", codec: "fmcs.v5" },
      range: null,
      resolution: [1, 1],
      sampleIdentity: "sample",
      scalar: new Float64Array([1]),
    });
    expect(degraded.layers.boundaries).toBe(false);
    expect(degraded.diagnostics).toEqual(expect.arrayContaining([
      "2D boundaries are unavailable: mesh overlay classification is unavailable or degraded.",
      "Planar color range is invalid and was not rendered.",
    ]));
  });

  it("rejects equal manual limits and invalid raster opacity without expanding or clamping", () => {
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1], canonicalUnit: "A/m", component: "normal",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { contours: false, mesh: false, raster: true, vectors: false },
      range: { mode: "manual", min: 1, max: 1 }, rasterOpacity: 2,
      resolution: [1, 1], sampleIdentity: "sample", scalar: new Float64Array([1]),
    });
    expect(model.range).toBeNull();
    expect(model.layers.raster).toBe(false);
    expect(model.diagnostics).toEqual(expect.arrayContaining([
      "Planar color range is invalid and was not rendered.",
      "Planar raster opacity is invalid and was not rendered.",
    ]));
  });
});
