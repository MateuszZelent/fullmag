import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildScalarChartSeries } from "../chartTableModel";
import { EChartsSurface, tableSeriesRenderModel } from "./EChartsSurface";

const sourceUrl = new URL("./EChartsSurface.tsx", import.meta.url);
const sharedSurfaceUrl = new URL("../../../shared/analysis-charts/InteractiveChartSurface.tsx", import.meta.url);
const canvasSurfaceUrl = new URL("../../../shared/analysis-charts/EChartsCanvasSurface.tsx", import.meta.url);
const rendererUrl = new URL("../../../shared/analysis-charts/chartRenderer.ts", import.meta.url);
const analysisStylesUrl = new URL("../../../design/styles/analysis-plots.css", import.meta.url);
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
  it("preserves the resource revision in export provenance", () => {
    const seriesWithRevision = series.map((entry) => ({ ...entry, dataRevision: 17 }));
    const model = tableSeriesRenderModel(
      seriesWithRevision,
      seriesWithRevision,  // allSeries = same as visible for this test
      "step",
    );
    expect(model.provenance?.dataRevision).toBe(17);
    expect(model.provenance?.descriptorId).toBe("analysis:data-table:default");
  });

  it("labels one or many normalized magnetization components consistently", () => {
    const single = tableSeriesRenderModel(series, series, "step");
    const multiTable = {
      columns: [
        { column_id: "step", dimension: "count", label: "Step", unit: "1" },
        { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
        { column_id: "my", dimension: "magnetization", label: "my", unit: "1" },
      ],
      rows: [[0, 0.1, 0.2]],
    };
    const multiSeries = buildScalarChartSeries(multiTable, {
      xAxisId: "step",
      yAxisIds: ["mx", "my"],
    });
    const multi = tableSeriesRenderModel(multiSeries, multiSeries, "step");

    expect(single.yAxes[0]).toMatchObject({ label: "Normalized magnetization m", unit: "1" });
    expect(multi.yAxes[0]).toMatchObject({ label: "Normalized magnetization m", unit: "1" });
  });

  it("does not relabel physical magnetization as normalized", () => {
    const physical = series.map((entry) => ({
      ...entry,
      id: "M_y",
      label: "Magnetization M",
      quantity: "M_y",
      unit: "A/m",
    }));

    expect(tableSeriesRenderModel(physical, physical, "step").yAxes[0]).toMatchObject({
      label: "Magnetization M",
      unit: "A/m",
    });
  });

  it("keeps the ECharts mount element present before table samples arrive", () => {
    const html = renderToStaticMarkup(
      <EChartsSurface series={[]} xAxisLabel="step" />
    );

    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain("No table samples");
  });

  it("keeps loaded chart data visible while ECharts mounts", () => {
    const html = renderToStaticMarkup(
      <EChartsSurface series={series} xAxisLabel="step" />
    );

    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).not.toContain("Loading chart renderer");
  });

  it("distinguishes an initial loading state from a retained-chart refresh", () => {
    const loadingHtml = renderToStaticMarkup(
      <EChartsSurface
        dataStatus="loading"
        series={[]}
        xAxisLabel="step"
      />
    );
    const refreshingHtml = renderToStaticMarkup(
      <EChartsSurface
        dataStatus="loading"
        presentation={{
          kind: "refreshing",
          requestedRevision: 42,
          visibleRevision: 41,
        }}
        series={series}
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

    expect(loadingHtml).toContain("Loading table samples");
    expect(refreshingHtml).toContain("Updating");
    expect(refreshingHtml).not.toContain("Loading table samples");
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Table samples unavailable");
  });

  it("does not mislabel intentionally hidden series as missing table samples", () => {
    const model = tableSeriesRenderModel([], series, "step");

    expect(model.status).toBe("empty");
    expect(model.statusMessage).toBe("All selected series are hidden");
  });

  it("delegates lifecycle to the shared frame-scheduled renderer owner", () => {
    const localSource = readFileSync(sourceUrl, "utf8");
    const sharedSource = [
      readFileSync(sharedSurfaceUrl, "utf8"),
      readFileSync(canvasSurfaceUrl, "utf8"),
      readFileSync(rendererUrl, "utf8"),
    ].join("\n");
    expect(localSource).toContain("InteractiveChartSurface");
    expect(localSource).toContain("chartCursorPointFromEChartsClick");
    expect(localSource).toContain("recordChartDispatchDataZoom");
    expect(localSource).toContain("if (onRangeChange) recordChartDispatchDataZoom");
    expect(localSource).toContain("scheduleRangeCommit");
    expect(sharedSource).toContain("EChartsCanvasSurface");
    expect(localSource).not.toContain("echarts.init");
    expect(sharedSource).toContain('renderer: "canvas"');
    expect(sharedSource).toContain("requestAnimationFrame");
    expect(sharedSource).toContain("ResizeObserver");
    expect(sharedSource).toContain("ownerRef.current?.dispose");
    expect(sharedSource).toContain(".catch(() =>");
    expect(sharedSource).not.toContain("setInterval");
  });

  it("reserves visible chart-frame space for export controls instead of clipping them below the canvas", () => {
    const styles = readFileSync(analysisStylesUrl, "utf8");

    expect(styles).toMatch(/\.fm-analysis-plots__chart-frame\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
    expect(styles).toMatch(/\.fm-analysis-chart-surface\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/);
    expect(styles).toMatch(/\.fm-analysis-chart-export\s*\{[^}]*flex:\s*0\s+0\s+auto/);
  });
});
