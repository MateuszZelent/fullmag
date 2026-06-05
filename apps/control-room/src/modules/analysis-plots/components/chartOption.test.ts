import { describe, expect, it } from "vitest";

import { buildScalarChartSeries } from "../chartTableModel";
import { buildChartOption } from "./chartOption";

describe("buildChartOption", () => {
  it("builds a production ECharts line option with bounded interaction chrome", () => {
    const series = buildScalarChartSeries(
      {
        columns: [
          { column_id: "step", dimension: "count", label: "step", unit: "1" },
          { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
        ],
        rows: [
          [1, 0.1],
          [2, Number.NaN],
          [3, 0.2],
        ],
      },
      { xAxisId: "step", yAxisIds: ["mx"] },
    );
    const option = buildChartOption(
      series,
      { xAxisLabel: "step [1]" },
      ["#89b4fa"],
    );

    expect(option.animation).toBe(false);
    expect(option.series).toEqual([
      expect.objectContaining({
        data: [
          [1, 0.1],
          [3, 0.2],
        ],
        name: "mx [1]",
        progressive: 0,
        showSymbol: false,
        type: "line",
      }),
    ]);
    expect(option.dataZoom).toEqual([
      expect.objectContaining({ filterMode: "none", type: "inside" }),
      expect.objectContaining({ filterMode: "none", type: "slider" }),
    ]);
    expect(JSON.stringify(option)).not.toContain("rgba(");
    expect(JSON.stringify(option)).toContain("var(--fm-border-muted)");
  });
});
