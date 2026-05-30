import { describe, expect, it } from "vitest";

import { __analysisPlotsTestUtils } from "./AnalysisPlotsModule";
import { buildLineChartModel } from "./analysisPlotModel";

describe("analysisPlotModel", () => {
  it("builds a normalized SVG path from finite points", () => {
    expect(
      buildLineChartModel([
        { x: 0, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 1 },
      ]),
    ).toMatchObject({
      path: "M12.00 128.00 L160.00 12.00 L308.00 128.00",
      xMax: 2,
      xMin: 0,
      yMax: 2,
      yMin: 1,
    });
  });

  it("returns null without finite samples", () => {
    expect(buildLineChartModel([{ x: Number.NaN, y: 1 }])).toBeNull();
  });
});

describe("analysis plot scalar selection", () => {
  it("uses physical scalar columns before time metadata", () => {
    expect(
      __analysisPlotsTestUtils.resolveScalarValueColumn([
        "step",
        "time",
        "solver_dt",
        "mx",
      ]),
    ).toBe(3);
    expect(
      __analysisPlotsTestUtils.scalarPointsFromWindow({
        columns: ["step", "time", "solver_dt", "e_total"],
        rows: [[4, 0.25, 0.01, -12.5]],
      }),
    ).toMatchObject({
      points: [{ x: 4, y: -12.5 }],
      yLabel: "e_total",
    });
  });
});
