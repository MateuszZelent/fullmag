import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildMappedVertexScalarColors,
  buildSampledScalarColors,
  buildSurfaceFaceScalarColors,
  buildThicknessAverageZScalarColors,
  buildVertexScalarColorsChunked,
  type ScalarColorBuffer,
} from "../viewport3dFieldMapping";
import {
  buildViewport3DFieldColorBuffer,
  estimateViewport3DFieldColorBuildInputBytes,
  estimateViewport3DFieldColorBuildOutputBytes,
  normalizeScalarValueForTests,
  normalizeScalarValueForShaderAttributeForTests,
  resolveScalarRangeForFieldForTests,
} from "./viewport3dFieldColorBuildModel";

function fieldVectorFixture(): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [4, 1, 1],
    nComp: 3,
    pointCount: 4,
    quantityId: "m",
    valueCount: 12,
    values: new Float64Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      -1, 0, 0,
    ]),
  };
}

function scalarComponentFieldVectorFixture(): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [3, 1, 1],
    nComp: 1,
    pointCount: 3,
    quantityId: "m",
    valueCount: 3,
    values: new Float64Array([10, 20, 30]),
  };
}

function expectColorBufferToMatch(
  actual: ScalarColorBuffer,
  expected: ScalarColorBuffer,
): void {
  expect(Array.from(actual.colors)).toEqual(Array.from(expected.colors));
  expect(actual.colorMode).toBe(expected.colorMode);
  expect(actual.colorPalette).toBe(expected.colorPalette);
  expect(actual.range).toEqual(expected.range);
  expect(
    actual.scalarValues ? Array.from(actual.scalarValues) : undefined,
  ).toEqual(expected.scalarValues ? Array.from(expected.scalarValues) : undefined);
  expect(
    actual.vectorValues ? Array.from(actual.vectorValues) : undefined,
  ).toEqual(expected.vectorValues ? Array.from(expected.vectorValues) : undefined);
}

describe("viewport3dFieldColorBuildModel", () => {
  it("matches current full-domain chunked color semantics", async () => {
    const fieldVector = fieldVectorFixture();
    const [expected, result] = await Promise.all([
      buildVertexScalarColorsChunked(fieldVector, {
        colorMode: "orientation",
        colorPalette: "viridis",
        shaderOnly: true,
      }),
      buildViewport3DFieldColorBuffer({
        colorMode: "orientation",
        colorPalette: "viridis",
        fieldVector,
        shaderOnly: true,
        target: {
          kind: "full-domain",
          vertexCount: fieldVector.pointCount,
        },
      }),
    ]);

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    if (!result) throw new Error("expected full-domain field color buffer");
    if (!expected) throw new Error("expected chunked scalar color buffer");
    expectColorBufferToMatch(result, expected);
  });

  it("matches current sampled color semantics including invalid sample fallback", async () => {
    const fieldVector = fieldVectorFixture();
    const pointIndices = new Uint32Array([0, 2, 99]);
    const expected = buildSampledScalarColors(
      fieldVector,
      pointIndices,
      "x",
      "magma",
    );

    const result = await buildViewport3DFieldColorBuffer({
      colorMode: "x",
      colorPalette: "magma",
      fieldVector,
      target: {
        kind: "sampled",
        pointIndices,
      },
    });

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    expectColorBufferToMatch(result!, expected!);
  });

  it("colors scalar component payloads as the selected component value", async () => {
    const fieldVector = scalarComponentFieldVectorFixture();
    const pointIndices = new Uint32Array([0, 1, 2]);
    const expected = buildSampledScalarColors(
      fieldVector,
      pointIndices,
      "z",
      "viridis",
    );

    const result = await buildViewport3DFieldColorBuffer({
      colorMode: "z",
      colorPalette: "viridis",
      fieldVector,
      target: {
        kind: "sampled",
        pointIndices,
      },
    });

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    expectColorBufferToMatch(result!, expected!);
  });

  it("rejects orientation colors for scalar component payloads", async () => {
    const fieldVector = scalarComponentFieldVectorFixture();

    await expect(
      buildViewport3DFieldColorBuffer({
        colorMode: "orientation",
        colorPalette: "viridis",
        fieldVector,
        target: {
          kind: "full-domain",
          vertexCount: fieldVector.pointCount,
        },
      }),
    ).resolves.toBeNull();
    await expect(
      buildViewport3DFieldColorBuffer({
        colorMode: "orientation",
        colorPalette: "viridis",
        fieldVector,
        target: {
          kind: "sampled",
          pointIndices: new Uint32Array([0, 1]),
        },
      }),
    ).resolves.toBeNull();
  });

  it("matches current mapped vertex color semantics", async () => {
    const fieldVector = fieldVectorFixture();
    const targetNodeIndices = new Uint32Array([2, 0, 3, 1]);
    const vertexCount = 5;
    const expected = buildMappedVertexScalarColors(
      fieldVector,
      targetNodeIndices,
      vertexCount,
      50_000,
      "magnitude",
      "coolwarm",
    );

    const result = await buildViewport3DFieldColorBuffer({
      colorMode: "magnitude",
      colorPalette: "coolwarm",
      fieldVector,
      target: {
        kind: "mapped-vertices",
        targetNodeIndices,
        vertexCount,
      },
    });

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    expectColorBufferToMatch(result!, expected!);
  });

  it("builds surface-face projection buffers for worker targets", async () => {
    const fieldVector = fieldVectorFixture();
    const surfaceIndices = Uint32Array.from([0, 1, 2]);
    const expected = buildSurfaceFaceScalarColors(
      fieldVector,
      surfaceIndices,
      4,
      "x",
      "viridis",
    );

    const result = await buildViewport3DFieldColorBuffer({
      colorMode: "x",
      colorPalette: "viridis",
      fieldVector,
      target: {
        kind: "surface-faces",
        surfaceIndices,
        vertexCount: 4,
      },
    });

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    expect(result).toMatchObject({
      geometryRole: "face_expanded_surface",
      projectionMode: "surface_faces",
      rangeSource: "face_values",
    });
    expectColorBufferToMatch(result!, expected!);
  });

  it("maps legacy scoped fields for worker surface-face projections", async () => {
    const fieldVector = fieldVectorFixture();
    fieldVector.pointCount = 3;
    fieldVector.grid = [3, 1, 1];
    fieldVector.valueCount = 9;
    fieldVector.values = new Float64Array([
      0, 0, 0,
      3, 0, 0,
      6, 0, 0,
    ]);
    const surfaceIndices = Uint32Array.from([3, 4, 5]);
    const targetNodeIndices = Uint32Array.from([3, 4, 5]);
    const expected = buildSurfaceFaceScalarColors(
      fieldVector,
      surfaceIndices,
      6,
      "x",
      "viridis",
      undefined,
      Number.POSITIVE_INFINITY,
      targetNodeIndices,
    );

    const result = await buildViewport3DFieldColorBuffer({
      colorMode: "x",
      colorPalette: "viridis",
      fieldVector,
      target: {
        kind: "surface-faces",
        surfaceIndices,
        targetNodeIndices,
        vertexCount: 6,
      },
    });

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    expect(result?.degradedFaceCount).toBe(0);
    expectColorBufferToMatch(result!, expected!);
  });

  it("builds thickness-average-z projection buffers for worker targets", async () => {
    const fieldVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [6, 1, 1],
      nComp: 3,
      pointCount: 6,
      quantityId: "m",
      valueCount: 18,
      values: new Float64Array([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, -1,
        0, 0, -1,
        0, 0, -1,
      ]),
    };
    const positions = Float32Array.from([
      0, 0, 1,
      1, 0, 1,
      0, 1, 1,
      0, 0, -1,
      1, 0, -1,
      0, 1, -1,
    ]);
    const surfaceIndices = Uint32Array.from([0, 1, 2]);
    const expected = buildThicknessAverageZScalarColors(
      fieldVector,
      positions,
      surfaceIndices,
      6,
      "orientation",
      "viridis",
    );

    const result = await buildViewport3DFieldColorBuffer({
      colorMode: "orientation",
      colorPalette: "viridis",
      fieldVector,
      target: {
        kind: "thickness-average-z",
        positions,
        surfaceIndices,
        vertexCount: 6,
      },
    });

    expect(result).not.toBeNull();
    expect(expected).not.toBeNull();
    expect(result).toMatchObject({
      geometryRole: "face_expanded_surface",
      lowNormFaceCount: 1,
      projectionMode: "thickness_average_z",
      rangeSource: "projected_values",
    });
    expectColorBufferToMatch(result!, expected!);
  });

  it("uses provided scalar ranges instead of scanning the field for stats", async () => {
    const fieldVector = fieldVectorFixture();
    let yieldCount = 0;

    const result = await buildViewport3DFieldColorBuffer({
      chunkSize: 2,
      colorMode: "magnitude",
      colorPalette: "viridis",
      fieldVector,
      scalarRange: { max: 2, min: 0 },
      target: {
        kind: "full-domain",
        vertexCount: fieldVector.pointCount,
      },
      yieldToMain: async () => {
        yieldCount += 1;
      },
    });

    expect(result).not.toBeNull();
    expect(result!.range).toEqual({ max: 2, min: 0 });
    expect(result!.scalarValues).toBeDefined();
    expect(yieldCount).toBe(1);
  });

  it("estimates input and output bytes for scheduler diagnostics", () => {
    const fieldVector = fieldVectorFixture();
    const pointIndices = new Uint32Array([0, 1, 2]);

    expect(
      estimateViewport3DFieldColorBuildInputBytes({
        fieldVector,
        target: {
          kind: "sampled",
          pointIndices,
        },
      }),
    ).toBe(fieldVector.values.byteLength + pointIndices.byteLength);
    expect(
      estimateViewport3DFieldColorBuildOutputBytes({
        colorMode: "orientation",
        fieldVector,
        shaderOnly: true,
        target: {
          kind: "full-domain",
          vertexCount: fieldVector.pointCount,
        },
      }),
    ).toBe(fieldVector.pointCount * 3 * Float32Array.BYTES_PER_ELEMENT);
    expect(
      estimateViewport3DFieldColorBuildInputBytes({
        fieldVector,
        target: {
          kind: "thickness-average-z",
          positions: new Float32Array(12),
          surfaceIndices: pointIndices,
          vertexCount: 4,
        },
      }),
    ).toBe(
      fieldVector.values.byteLength +
        12 * Float32Array.BYTES_PER_ELEMENT +
        pointIndices.byteLength,
    );
  });

  describe("normalizeScalarValue (S-05 relative epsilon)", () => {
    it("maps values linearly when span is well-defined", () => {
      expect(normalizeScalarValueForTests(5, { max: 10, min: 0 })).toBe(0.5);
      expect(normalizeScalarValueForTests(0, { max: 10, min: 0 })).toBe(0);
      expect(normalizeScalarValueForTests(10, { max: 10, min: 0 })).toBe(1);
    });

    it("clamps values outside the range to [0, 1]", () => {
      expect(normalizeScalarValueForTests(-5, { max: 10, min: 0 })).toBe(0);
      expect(normalizeScalarValueForTests(15, { max: 10, min: 0 })).toBe(1);
    });

    it("returns 0.5 for degenerate range at micromagnetic scale (Ms ≈ 8e5)", () => {
      expect(
        normalizeScalarValueForTests(800000, { max: 800000, min: 800000 }),
      ).toBe(0.5);
    });

    it("returns 0.5 for float32 ULP rounding noise on uniform high-magnitude field", () => {
      // span is 0.0625, scale is 800000. span (0.0625) <= 1e-6 * 800000 (0.8) -> degenerate
      expect(
        normalizeScalarValueForTests(800000.0625, {
          max: 800000.0625,
          min: 800000,
        }),
      ).toBe(0.5);
    });

    it("returns 0.5 for degenerate range at zero", () => {
      expect(normalizeScalarValueForTests(0, { max: 0, min: 0 })).toBe(0.5);
    });

    it("returns 0.5 for degenerate range below 1e-6 absolute floor", () => {
      expect(
        normalizeScalarValueForTests(1e-8, { max: 1e-8, min: 1e-8 }),
      ).toBe(0.5);
    });

    it("returns 0.5 for non-finite values and non-finite range boundaries", () => {
      expect(normalizeScalarValueForTests(Number.NaN, { max: 10, min: 0 })).toBe(0.5);
      expect(
        normalizeScalarValueForTests(Number.POSITIVE_INFINITY, { max: 10, min: 0 }),
      ).toBe(0.5);
      expect(
        normalizeScalarValueForTests(Number.NEGATIVE_INFINITY, { max: 10, min: 0 }),
      ).toBe(0.5);
      expect(normalizeScalarValueForTests(5, { max: Number.NaN, min: 0 })).toBe(0.5);
      expect(normalizeScalarValueForTests(5, { max: 10, min: Number.NaN })).toBe(0.5);
      expect(
        normalizeScalarValueForTests(5, null as unknown as Parameters<typeof normalizeScalarValueForTests>[1]),
      ).toBe(0.5);
      expect(
        normalizeScalarValueForTests(5, undefined as unknown as Parameters<typeof normalizeScalarValueForTests>[1]),
      ).toBe(0.5);
    });

    it("returns 0.5 for inverted range where min > max", () => {
      expect(normalizeScalarValueForTests(5, { max: 0, min: 10 })).toBe(0.5);
    });
  });

  describe("normalizeScalarValueForShaderAttribute (S-07)", () => {
    it("matches normalizeScalarValue for finite values", () => {
      expect(
        normalizeScalarValueForShaderAttributeForTests(5, { max: 10, min: 0 }),
      ).toBe(0.5);
      expect(
        normalizeScalarValueForShaderAttributeForTests(800000, {
          max: 800000,
          min: 800000,
        }),
      ).toBe(0.5);
    });

    it("passes NaN/Inf/overflow sentinels through unnormalized so the GPU fragment shader's bad-value detection still fires", () => {
      expect(
        normalizeScalarValueForShaderAttributeForTests(Number.NaN, {
          max: 10,
          min: 0,
        }),
      ).toBe(Number.NaN);
      expect(
        normalizeScalarValueForShaderAttributeForTests(Number.POSITIVE_INFINITY, {
          max: 10,
          min: 0,
        }),
      ).toBe(Number.POSITIVE_INFINITY);
      expect(
        normalizeScalarValueForShaderAttributeForTests(4e38, { max: 10, min: 0 }),
      ).toBe(4e38);
      expect(
        normalizeScalarValueForShaderAttributeForTests(15, { max: 10, min: 0 }),
      ).toBe(1);
    });
  });

  describe("resolveScalarRangeForField (S-06 NaN/Inf handling)", () => {
    it("skips NaN and Inf in field vector without collapsing valid range to {0, 0}", async () => {
      const fieldVector: DecodedFieldVector = {
        dtype: "float64",
        grid: [4, 1, 1],
        nComp: 1,
        pointCount: 4,
        quantityId: "m",
        valueCount: 4,
        values: new Float64Array([10, Number.NaN, Number.POSITIVE_INFINITY, 25]),
      };

      const range = await resolveScalarRangeForFieldForTests(
        fieldVector,
        "magnitude",
        { chunkSize: 2 },
      );

      expect(range).toEqual({ max: 25, min: 10 });
    });

    it("returns { max: 0, min: 0 } when all values are non-finite", async () => {
      const fieldVector: DecodedFieldVector = {
        dtype: "float64",
        grid: [3, 1, 1],
        nComp: 1,
        pointCount: 3,
        quantityId: "m",
        valueCount: 3,
        values: new Float64Array([
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ]),
      };

      const range = await resolveScalarRangeForFieldForTests(
        fieldVector,
        "magnitude",
        { chunkSize: 1 },
      );

      expect(range).toEqual({ max: 0, min: 0 });
    });

    it("builds CPU color buffer for field with NaN and Inf without throwing TypeError", async () => {
      const fieldVector: DecodedFieldVector = {
        dtype: "float64",
        grid: [4, 1, 1],
        nComp: 1,
        pointCount: 4,
        quantityId: "m",
        valueCount: 4,
        values: new Float64Array([0, Number.NaN, Number.POSITIVE_INFINITY, 10]),
      };

      const result = await buildViewport3DFieldColorBuffer({
        colorMode: "magnitude",
        colorPalette: "viridis",
        fieldVector,
        shaderOnly: false,
        target: {
          kind: "full-domain",
          vertexCount: 4,
        },
      });

      expect(result).not.toBeNull();
      expect(result?.range).toEqual({ max: 10, min: 0 });
      expect(result?.colors.length).toBe(12);
      // Ensure all color values are finite numbers (no NaN colors)
      for (let i = 0; i < result!.colors.length; i += 1) {
        expect(Number.isFinite(result!.colors[i])).toBe(true);
      }
    });
  });

  describe("resolveScalarRangeForField diverging-palette auto-symmetric range (S-11)", () => {
    function componentFieldVector(componentIndex: 0 | 1 | 2, values: number[]): DecodedFieldVector {
      const flat: number[] = [];
      for (const value of values) {
        const point = [0, 0, 0];
        point[componentIndex] = value;
        flat.push(...point);
      }
      return {
        dtype: "float64",
        grid: [values.length, 1, 1],
        nComp: 3,
        pointCount: values.length,
        quantityId: "m",
        valueCount: flat.length,
        values: new Float64Array(flat),
      };
    }

    it("symmetrizes an asymmetric x-component range around zero for a diverging palette", async () => {
      const fieldVector = componentFieldVector(0, [-2, 1, 5]);

      const range = await resolveScalarRangeForFieldForTests(fieldVector, "x", {
        chunkSize: 2,
        colorPalette: "coolwarm",
      });

      expect(range).toEqual({ max: 5, min: -5 });
    });

    it("leaves an asymmetric x-component range untouched for a sequential palette", async () => {
      const fieldVector = componentFieldVector(0, [-2, 1, 5]);

      const range = await resolveScalarRangeForFieldForTests(fieldVector, "x", {
        chunkSize: 2,
        colorPalette: "viridis",
      });

      expect(range).toEqual({ max: 5, min: -2 });
    });

    it("does not symmetrize magnitude mode even with a diverging palette", async () => {
      const fieldVector: DecodedFieldVector = {
        dtype: "float64",
        grid: [3, 1, 1],
        nComp: 1,
        pointCount: 3,
        quantityId: "m",
        valueCount: 3,
        values: new Float64Array([1, 4, 9]),
      };

      const range = await resolveScalarRangeForFieldForTests(fieldVector, "magnitude", {
        chunkSize: 2,
        colorPalette: "coolwarm",
      });

      expect(range).toEqual({ max: 9, min: 1 });
    });

    it("leaves a caller-provided explicit scalarRange untouched even for a diverging palette", async () => {
      const fieldVector = componentFieldVector(0, [-2, 1, 5]);

      const range = await resolveScalarRangeForFieldForTests(fieldVector, "x", {
        chunkSize: 2,
        colorPalette: "coolwarm",
        scalarRange: { max: 5, min: -2 },
      });

      expect(range).toEqual({ max: 5, min: -2 });
    });
  });
});
