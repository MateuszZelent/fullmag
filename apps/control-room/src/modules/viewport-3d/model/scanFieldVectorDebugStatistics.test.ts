import { describe, expect, it, vi } from "vitest";

import {
  buildFieldVectorDebugSamples,
  selectFieldVectorDebugSampleIndices,
  scanFieldVectorDebugStatistics,
} from "./scanFieldVectorDebugStatistics";

describe("selectFieldVectorDebugSampleIndices", () => {
  it.each([0, 1, 2, 12, 13, 1_000_000])("selects deterministic bounded samples for %i points", (count) => {
    const first = selectFieldVectorDebugSampleIndices(count);
    expect(first).toEqual(selectFieldVectorDebugSampleIndices(count));
    expect(first.length).toBe(Math.min(count, 12));
    expect(new Set(first).size).toBe(first.length);
    if (count > 0) expect(first[0]).toBe(0);
    if (count > 1) expect(first.at(-1)).toBe(count - 1);
    if (count > 2) expect(first).toContain(Math.floor((count - 1) / 2));
  });
});

describe("field vector debug statistics", () => {
  it("bounds components, samples node indices and preserves non-finite evidence", () => {
    const values = new Float64Array(18);
    values[0] = Number.NaN;
    values[1] = Number.POSITIVE_INFINITY;
    values[9] = 3;
    const result = buildFieldVectorDebugSamples({
      nComp: 9,
      nodeIndices: new Uint32Array([41, 99]),
      pointCount: 2,
      values,
    });
    expect(result.samples[0]).toMatchObject({ componentValues: [null, null, 0, 0, 0, 0, 0, 0], magnitude: null, nodeIndex: 41, pointIndex: 0 });
    expect(result.samples[1]).toMatchObject({ nodeIndex: 99, pointIndex: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "component-display-cap" }));
    expect(Object.isFrozen(result.samples)).toBe(true);
  });

  it("normalizes invalid readonly-array node indices to null in the object model", () => {
    const result = buildFieldVectorDebugSamples({
      nComp: 1,
      nodeIndices: [Number.NaN, Number.POSITIVE_INFINITY, 3.5, -1, Number.MAX_SAFE_INTEGER + 1, 42],
      pointCount: 6,
      values: new Float64Array(6),
    });
    expect(result.samples.map((sample) => sample.nodeIndex)).toEqual([
      null,
      null,
      null,
      null,
      null,
      42,
    ]);
  });

  it("cooperatively scans one million values without copying or retaining input", async () => {
    const values = new Float64Array(1_000_000);
    values[999_999] = 5;
    const yieldToMain = vi.fn(async () => undefined);
    const result = await scanFieldVectorDebugStatistics(values, { yieldToMain });
    expect(result).toMatchObject({ finiteCount: 1_000_000, max: 5, min: 0, nonFiniteCount: 0, zeroCount: 999_999 });
    expect(yieldToMain).toHaveBeenCalled();
    expect(Object.values(result)).not.toContain(values);
  });

  it("cancels cooperatively through AbortSignal", async () => {
    const controller = new AbortController();
    const scan = scanFieldVectorDebugStatistics(new Float64Array(200_000), {
      signal: controller.signal,
      yieldToMain: async () => controller.abort(),
    });
    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
  });

  it("counts NaN and Infinity without emitting non-JSON-safe numbers", async () => {
    const result = await scanFieldVectorDebugStatistics(
      new Float64Array([0, Number.NaN, Number.POSITIVE_INFINITY, -2, 4]),
    );
    expect(result).toMatchObject({
      finiteCount: 3,
      max: 4,
      mean: 2 / 3,
      min: -2,
      nonFiniteCount: 2,
      zeroCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("null,null");
  });
});
