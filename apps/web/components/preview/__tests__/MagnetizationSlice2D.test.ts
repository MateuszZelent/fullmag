import { describe, expect, it } from "vitest";

import {
  buildSlice2DChartTopologyKey,
  resolveHeatmapTooltipValue,
} from "../magnetizationSliceUtils";

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

describe("buildSlice2DChartTopologyKey", () => {
  it("ignores field data revisions and only tracks the slice frame", () => {
    expect(buildSlice2DChartTopologyKey("xy", 32, 24)).toBe("xy:32:24");
    expect(buildSlice2DChartTopologyKey("xy", 32, 24)).toBe(
      buildSlice2DChartTopologyKey("xy", 32, 24),
    );
    expect(buildSlice2DChartTopologyKey("xz", 32, 24)).not.toBe(
      buildSlice2DChartTopologyKey("xy", 32, 24),
    );
  });
});
