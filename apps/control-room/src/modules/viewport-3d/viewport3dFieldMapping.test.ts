import { describe, expect, it, vi } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildVertexScalarColors,
  buildVertexScalarColorsChunked,
  fieldTransformNeedsChunking,
  resolveScalarRange,
} from "./viewport3dFieldMapping";

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
    expect(Array.from(result?.colors ?? [])).toEqual([
      0, expect.closeTo(0.38), 1,
      1, expect.closeTo(0.38), 0,
    ]);
  });

  it("requires chunking above the synchronous color transform threshold", () => {
    expect(fieldTransformNeedsChunking(50_001)).toBe(true);
    expect(buildVertexScalarColors(vectorField([1, 0, 0]), 1, 0)).toBeNull();
  });

  it("builds colors through a chunked cancellable transform", async () => {
    const yieldToMain = vi.fn(async () => undefined);
    const result = await buildVertexScalarColorsChunked(
      vectorField([0, 1, 2], 1),
      { chunkSize: 1, yieldToMain },
    );

    expect(resolveScalarRange(vectorField([0, 1, 2], 1))).toEqual({
      max: 2,
      min: 0,
    });
    expect(result.colors).toHaveLength(9);
    expect(yieldToMain).toHaveBeenCalledTimes(2);
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
