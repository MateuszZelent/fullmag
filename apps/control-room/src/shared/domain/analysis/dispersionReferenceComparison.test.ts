import { describe, expect, it } from "vitest";
import { dispersionReferenceComparisons } from "./dispersionReferenceComparison";
import type { ChartSeries } from "./chartSeries";

describe("dispersion reference frequency errors", () => {
  const series = [
    { id: "FEM", quantity: "frequency", unit: "GHz", points: [{ rowIndex: 7, sampleIndex: 7, pathS: 1, x: 1, y: 10.1 }] },
    { id: "reference", label: "Reference", quantity: "reference_frequency", unit: "GHz", points: [
      { rowIndex: 0, pathS: 0, x: 0, y: 9 }, { rowIndex: 1, pathS: 2, x: 2, y: 11 },
    ] },
  ] as ChartSeries[];
  it("compares in common frequency units and preserves source sample identity", () => {
    const comparison = dispersionReferenceComparisons(series)[0]!;
    expect(comparison.rows[0]).toMatchObject({ sampleIndex: 7, rowIndex: 7, referenceFrequency: 10 });
    expect(comparison.maximumAbsoluteErrorPercent).toBeCloseTo(1, 10);
  });
  it("does not extrapolate, mix units or interpolate through reference gaps", () => {
    expect(dispersionReferenceComparisons([{ ...series[0]!, unit: "Hz" }, series[1]!])).toEqual([]);
    expect(dispersionReferenceComparisons([series[0]!, { ...series[1]!, points: [series[1]!.points[0]!] }])).toEqual([]);
    expect(dispersionReferenceComparisons([series[0]!, { ...series[1]!, points: [series[1]!.points[0]!, { ...series[1]!.points[1]!, breakBefore: true }] }])).toEqual([]);
  });
});
