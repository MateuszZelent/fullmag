import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildMappedVertexScalarColors,
  buildSampledScalarColors,
  buildVertexScalarColorsChunked,
  type ScalarColorBuffer,
} from "../viewport3dFieldMapping";
import {
  buildViewport3DFieldColorBuffer,
  estimateViewport3DFieldColorBuildInputBytes,
  estimateViewport3DFieldColorBuildOutputBytes,
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
    expectColorBufferToMatch(result!, expected);
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
  });
});
