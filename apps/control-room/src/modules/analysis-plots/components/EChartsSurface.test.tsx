import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildScalarChartSeries } from "../chartTableModel";
import { EChartsSurface } from "./EChartsSurface";

const sourceUrl = new URL("./EChartsSurface.tsx", import.meta.url);
const surfaceModelUrl = new URL("./chartSurfaceModel.ts", import.meta.url);
const table = {
  columns: [
    { column_id: "step", dimension: "count", label: "Step", unit: "1" },
    { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
  ],
  rows: [
    [0, 0.1],
    [1, 0.2],
  ],
};
const series = buildScalarChartSeries(table, {
  xAxisId: "step",
  yAxisIds: ["mx"],
});

describe("EChartsSurface", () => {
  it("keeps the ECharts mount element present before table samples arrive", () => {
    const html = renderToStaticMarkup(
      <EChartsSurface series={[]} xAxisLabel="step" />
    );

    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain("No table samples");
  });

  it("shows renderer loading state while ECharts is not mounted yet", () => {
    const html = renderToStaticMarkup(
      <EChartsSurface series={series} xAxisLabel="step" />
    );

    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading chart renderer");
  });

  it("distinguishes table loading and error states from an empty sample set", () => {
    const loadingHtml = renderToStaticMarkup(
      <EChartsSurface
        dataStatus="loading"
        series={[]}
        xAxisLabel="step"
      />
    );
    const errorHtml = renderToStaticMarkup(
      <EChartsSurface
        dataStatus="error"
        series={[]}
        xAxisLabel="step"
      />
    );

    expect(loadingHtml).toContain('role="status"');
    expect(loadingHtml).toContain("Loading table samples");
    expect(loadingHtml).not.toContain("No table samples");
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Table samples unavailable");
  });

  it("schedules chart updates by animation frame instead of polling", () => {
    const source = [
      readFileSync(sourceUrl, "utf8"),
      readFileSync(surfaceModelUrl, "utf8"),
    ].join("\n");

    expect(source).toContain("createChartFrameScheduler");
    expect(source).toContain("scheduleChartOptionUpdate");
    expect(source).toContain('chart.on("dataZoom"');
    expect(source).toContain('chart.on("click"');
    expect(source).toContain("chartCursorPointFromEChartsClick");
    expect(source).toContain("if (onRangeChangeRef.current)");
    expect(source).toContain("recordChartDispatchDataZoom");
    expect(source).toContain("scheduleRangeCommit");
    expect(source).toContain("resizeScheduler.schedule");
    expect(source).toContain(".catch(() =>");
    expect(source).toContain("Chart renderer unavailable");
    expect(source).not.toContain("setInterval");
  });
});
