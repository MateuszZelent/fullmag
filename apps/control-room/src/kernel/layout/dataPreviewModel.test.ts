import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildDataPreviewRows,
  buildDataPreviewSignature,
  normalizeDataPreviewSampleCount,
} from "./dataPreviewModel";

function fieldVector(values: number[], nComp = 3): DecodedFieldVector {
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

describe("dataPreviewModel", () => {
  it("normalizes sample counts for lightweight field previews", () => {
    expect(normalizeDataPreviewSampleCount("0")).toBe(1);
    expect(normalizeDataPreviewSampleCount("12")).toBe(12);
    expect(normalizeDataPreviewSampleCount("999")).toBe(64);
  });

  it("formats rows from the center of a decoded field vector", () => {
    const rows = buildDataPreviewRows(
      fieldVector([
        0, 0.1, 0.2,
        1, 1.1, 1.2,
        2, 2.1, 2.2,
        3, 3.1, 3.2,
        4, 4.1, 4.2,
      ]),
      3,
    );

    expect(rows).toEqual([
      { index: 0, sourceIndex: 1, values: ["1", "1.1", "1.2"] },
      { index: 1, sourceIndex: 2, values: ["2", "2.1", "2.2"] },
      { index: 2, sourceIndex: 3, values: ["3", "3.1", "3.2"] },
    ]);
  });

  it("builds a short signature from the visible sample values", () => {
    expect(
      buildDataPreviewSignature(
        fieldVector([1, 0, 0, 0, 1, 0, -1, 0, 0]),
        3,
      ),
    ).toMatch(/^3x3:/);
  });
});
