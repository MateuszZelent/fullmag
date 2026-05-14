import { describe, expect, it, vi } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildSampledScalarColors,
  buildVertexScalarColors,
  buildVertexScalarColorsChunked,
  fieldTransformNeedsChunking,
  resolveScalarRange,
} from "./viewport3dFieldMapping";
import { magnitudeColorRgb } from "./viewport3dVectorColoring";

function vectorField(values: number[], nComp = 3): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / nComp, 1, 1],
    nComp,
    pointCount: values.length / nComp,
    quantityId: "m",
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

describe("viewport3dFieldMapping", () => {
  it("maps vector magnitude to per-vertex scalar colors", () => {
    const result = buildVertexScalarColors(
      vectorField([
        0, 0, 0,
        1, 0, 0,
      ]),
      2,
    );

    expect(result?.range).toEqual({ max: 1, min: 0 });
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(Float32Array.from([...magnitudeColorRgb(0), ...magnitudeColorRgb(1)])),
    );
  });

  it("maps orientation mode through canonical physical XYZ", () => {
    const result = buildVertexScalarColors(
      vectorField([
        1, 0, 0,
        0, 0, 1,
      ]),
      2,
      undefined,
      "orientation",
    );

    expect(Array.from(result?.colors ?? [])).toEqual([
      1, 0, 0,
      1, 1, 1,
    ]);
  });

  it("accepts HSLSPHERE aliases for surface orientation coloring", () => {
    const result = buildVertexScalarColors(
      vectorField([0, 0, 1]),
      1,
      undefined,
      "HSLSPHERE",
    );

    expect(Array.from(result?.colors ?? [])).toEqual([1, 1, 1]);
  });

  it("maps component color modes through the scalar gradient", () => {
    const result = buildVertexScalarColors(
      vectorField([
        -1, 0, 0,
        1, 0, 0,
      ]),
      2,
      undefined,
      "x",
    );

    expect(result?.range).toEqual({ max: 1, min: -1 });
    expect(Array.from(result?.colors ?? [])).toEqual([
      0, expect.closeTo(0.38), 1,
      1, expect.closeTo(0.38), 0,
    ]);
  });

  it("maps sampled point indices to compact scalar colors", () => {
    const result = buildSampledScalarColors(
      vectorField([
        -1, 0, 0,
        0, 0, 1,
        1, 0, 0,
      ]),
      Uint32Array.from([0, 2]),
      "x",
    );

    expect(result?.range).toEqual({ max: 1, min: -1 });
    expect(Array.from(result?.colors ?? [])).toEqual([
      0, expect.closeTo(0.38), 1,
      1, expect.closeTo(0.38), 0,
    ]);
  });

  it("rejects sampled indices outside field coverage", () => {
    expect(
      buildSampledScalarColors(
        vectorField([1, 0, 0]),
        Uint32Array.from([0, 1]),
        "orientation",
      ),
    ).toBeNull();
  });

  it("keeps monochrome mode on the material color", () => {
    expect(
      buildVertexScalarColors(
        vectorField([1, 0, 0]),
        1,
        undefined,
        "monochrome",
      ),
    ).toBeNull();
  });

  it("requires chunking above the synchronous color transform threshold", () => {
    expect(fieldTransformNeedsChunking(50_001)).toBe(true);
    expect(buildVertexScalarColors(vectorField([1, 0, 0]), 1, 0)).toBeNull();
  });

  it("maps prefix partial field coverage while leaving unmatched topology nodes black", () => {
    const result = buildVertexScalarColors(
      vectorField([0, 0, 1]),
      2,
      undefined,
      "orientation",
    );

    expect(Array.from(result?.colors ?? [])).toEqual([
      1, 1, 1,
      0, 0, 0,
    ]);
  });

  it("rejects field with more points than the topology vertex count", () => {
    // fieldVector.pointCount (2) > vertexCount (1): invalid — cannot map.
    expect(buildVertexScalarColors(vectorField([1, 0, 0, 0, 1, 0]), 1)).toBeNull();
  });

  it("builds colors through a chunked cancellable transform", async () => {
    const yieldToMain = vi.fn(async () => undefined);
    const result = await buildVertexScalarColorsChunked(
      vectorField([0, 1, 2], 1),
      { chunkSize: 1, colorMode: "magnitude", yieldToMain },
    );

    expect(resolveScalarRange(vectorField([0, 1, 2], 1))).toEqual({
      max: 2,
      min: 0,
    });
    expect(result.colors).toHaveLength(9);
    expect(yieldToMain).toHaveBeenCalledTimes(4);
  });

  it("aborts stale chunked field transforms", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildVertexScalarColorsChunked(vectorField([0, 1, 2], 1), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
