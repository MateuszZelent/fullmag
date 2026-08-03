import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InteractiveChartSurface, chartSeriesRenderModel } from "./InteractiveChartSurface";

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
  it("renders caller-owned identity and presentation copy", () => {
    expect(renderToStaticMarkup(
      <InteractiveChartSurface
        series={series}
        surface={{
          ariaLabel: "Live magnetization",
          chartId: "live:magnetization",
          presentationCopy: { empty: "No live samples", error: "Live data unavailable", loading: "Loading live samples" },
          provenance: { dataRevision: 7, decimation: "tail", descriptorId: "live:magnetization", query: "tail=100", resourceKey: "live/magnetization" },
        }}
        xAxisLabel="time [s]"
      />,
    )).toContain('class="fm-analysis-plots__echarts"');
  });

  it("keeps caller-owned chart and provenance identity in the shared render model", () => {
    expect(chartSeriesRenderModel(series, series, {
      ariaLabel: "Live magnetization",
      chartId: "live:magnetization",
      presentationCopy: { empty: "No live samples", error: "Live data unavailable", loading: "Loading live samples" },
      provenance: { dataRevision: 7, decimation: "tail", descriptorId: "live:magnetization", query: "tail=100", resourceKey: "live/magnetization" },
    }, "time [s]", "loading")).toMatchObject({
      ariaLabel: "Live magnetization",
      key: "live:magnetization",
      provenance: { dataRevision: 7, descriptorId: "live:magnetization", resourceKey: "live/magnetization" },
      series: [{ id: "analysis:mx", points: series[0]?.points }],
      statusMessage: "Loading live samples",
      xAxis: { label: "time [s]", unit: "s" },
    });
  });

});
