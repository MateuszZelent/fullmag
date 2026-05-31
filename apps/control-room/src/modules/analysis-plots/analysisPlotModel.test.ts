import { describe, expect, it } from "vitest";

import { __analysisPlotsTestUtils } from "./AnalysisPlotsModule";
import { buildLineChartModel, MAX_LINE_CHART_POINTS } from "./analysisPlotModel";

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

  it("decimates large histories while preserving the full value range", () => {
    const points = Array.from({ length: 1_000 }, (_, index) => ({
      x: index,
      y: index === 511 ? 100 : Math.sin(index / 10),
    }));

    const model = buildLineChartModel(points);

    expect(model?.path.match(/[ML]/g)?.length).toBeLessThanOrEqual(
      MAX_LINE_CHART_POINTS,
    );
    expect(model).toMatchObject({
      xMax: 999,
      xMin: 0,
      yMax: 100,
    });
  });
});

describe("analysis plot scalar selection", () => {
  it("uses one stable scalar column query for resource subscriptions", () => {
    expect(__analysisPlotsTestUtils.analysisScalarColumns).toEqual([
      "step",
      "e_total",
      "mx",
      "my",
      "mz",
    ]);
    expect(Object.isFrozen(__analysisPlotsTestUtils.analysisScalarColumns)).toBe(
      true,
    );
  });

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
