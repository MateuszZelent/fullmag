import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InteractiveChartSurface, chartSeriesRenderModel } from "./InteractiveChartSurface";

const sourceUrl = new URL("./InteractiveChartSurface.tsx", import.meta.url);

const series = [{
  id: "analysis:mx",
  label: "m_x",
  points: [{ rowIndex: 0, x: 0, y: 1 }],
  quantity: "mx",
  source: { kind: "data.table.rows" as const, resourceKey: "data", tableId: "default" },
  status: "ready" as const,
  unit: "1",
  xUnit: "s",
}];

describe("InteractiveChartSurface", () => {
  it("renders the neutral chart contract without module imports", () => {
    expect(renderToStaticMarkup(
      <InteractiveChartSurface series={series} xAxisLabel="time [s]" />,
    )).toContain('class="fm-analysis-plots__echarts"');
    expect(readFileSync(sourceUrl, "utf8")).not.toContain("@/modules/");
  });

  it("maps point and SI range callbacks through the shared render model", () => {
    expect(chartSeriesRenderModel(series, series, "time [s]")).toMatchObject({
      series: [{ id: "analysis:mx", points: series[0]?.points }],
      xAxis: { label: "time [s]", unit: "s" },
    });
  });
});
