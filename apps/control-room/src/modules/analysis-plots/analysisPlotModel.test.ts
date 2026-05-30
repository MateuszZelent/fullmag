import { describe, expect, it } from "vitest";

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
