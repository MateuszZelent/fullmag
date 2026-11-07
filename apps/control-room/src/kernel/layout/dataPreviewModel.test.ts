import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildDataPreviewRows,
  buildDataPreviewSignature,
  buildDataPreviewStepSignature,
  buildDataPreviewStepTimestamp,
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

  it("skips zero-valued points and expands around the center sample", () => {
    const rows = buildDataPreviewRows(
      fieldVector([
        9, 9, 9,
        0, 0, 0,
        2, 2, 2,
        0, 0, 0,
        4, 4, 4,
      ]),
      3,
    );

    expect(rows).toEqual([
      { index: 0, sourceIndex: 2, values: ["2", "2", "2"] },
      { index: 1, sourceIndex: 0, values: ["9", "9", "9"] },
      { index: 2, sourceIndex: 4, values: ["4", "4", "4"] },
    ]);
  });

  it.each<[number, number, number[]]>([
    [4, 2, [1, 2]],
    [5, 2, [1, 2]],
    [4, 3, [0, 1, 2]],
    [5, 3, [1, 2, 3]],
  ])("preserves center ordering for %i points and %i samples", (points, samples, expected) => {
    const values = Array.from({ length: points }, (_, index) => index + 1);
    const rows = buildDataPreviewRows(fieldVector(values, 1), samples);

    expect(rows.map((row) => row.sourceIndex)).toEqual(expected);
    expect(rows.map((row) => row.values)).toEqual(expected.map((index) => [String(index + 1)]));
  });

  it("expands through zeros and retains all nine tensor components", () => {
    const values = new Array<number>(45).fill(0);
    for (let component = 0; component < 9; component += 1) values[component] = component + 1;
    values[44] = -9;
    const tensor = fieldVector(values, 9);
    const rows = buildDataPreviewRows(tensor, 2);

    expect(rows).toEqual([
      { index: 0, sourceIndex: 0, values: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
      { index: 1, sourceIndex: 4, values: ["0", "0", "0", "0", "0", "0", "0", "0", "-9"] },
    ]);
    expect(buildDataPreviewSignature(tensor, 2)).toMatch(/^2x9:/);
    expect(buildDataPreviewRows(fieldVector(new Array<number>(45).fill(0), 9), 2)).toEqual([]);
  });

  it("builds a short signature from the visible sample values", () => {
    expect(
      buildDataPreviewSignature(
        fieldVector([1, 0, 0, 0, 1, 0, -1, 0, 0]),
        3,
      ),
    ).toMatch(/^3x3:/);
  });

  it("builds a live step signature from solver status", () => {
    const status = {
      last_step_updated_at_unix_ms: Date.UTC(2026, 4, 31, 10, 20, 30, 123),
      revision: 44,
      runtime_state: "running",
      sim_time_seconds: 2.5e-9,
      step_index: 42,
    };

    expect(buildDataPreviewStepSignature(status)).toBe(
      "step 42 | t=2.5000e-9 s | updated 2026-05-31T10:20:30.123Z | rev 44",
    );
    expect(buildDataPreviewStepTimestamp(status)).toBe(
      "2026-05-31T10:20:30.123Z",
    );
  });
});
