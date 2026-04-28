import { describe, expect, it } from "vitest";

import { resolveHeatmapTooltipValue } from "../MagnetizationSlice2D";

describe("resolveHeatmapTooltipValue", () => {
  it("accepts direct heatmap tooltip values", () => {
    expect(resolveHeatmapTooltipValue({ value: [3, 4, 0.25] })).toEqual([3, 4, 0.25]);
  });

  it("accepts array wrapped ECharts tooltip params", () => {
    expect(resolveHeatmapTooltipValue([{ value: [1, 2, -0.5] }])).toEqual([1, 2, -0.5]);
  });

  it("ignores stale or empty tooltip params", () => {
    expect(resolveHeatmapTooltipValue(undefined)).toBeNull();
    expect(resolveHeatmapTooltipValue({})).toBeNull();
    expect(resolveHeatmapTooltipValue({ value: [] })).toBeNull();
  });
});
