import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildScalarChartSeries } from "../chartTableModel";
import { EChartsSurface, tableSeriesRenderModel } from "./EChartsSurface";

const sourceUrl = new URL("./EChartsSurface.tsx", import.meta.url);
const sharedSurfaceUrl = new URL("../../../shared/analysis-charts/EChartsCanvasSurface.tsx", import.meta.url);
const rendererUrl = new URL("../../../shared/analysis-charts/chartRenderer.ts", import.meta.url);
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
    const model = tableSeriesRenderModel(
      series.map((entry) => ({ ...entry, dataRevision: 17 })),
      "step",
    );
    expect(model.provenance?.dataRevision).toBe(17);
  });

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

  it("delegates lifecycle to the shared frame-scheduled renderer owner", () => {
    const localSource = readFileSync(sourceUrl, "utf8");
    const sharedSource = [
      readFileSync(sharedSurfaceUrl, "utf8"),
      readFileSync(rendererUrl, "utf8"),
    ].join("\n");
    expect(localSource).toContain("EChartsCanvasSurface");
    expect(localSource).toContain("chartCursorPointFromEChartsClick");
    expect(localSource).toContain("recordChartDispatchDataZoom");
    expect(localSource).toContain("if (onRangeChange) recordChartDispatchDataZoom");
    expect(localSource).toContain("scheduleRangeCommit");
    expect(localSource).not.toContain("echarts.init");
    expect(sharedSource).toContain('renderer: "canvas"');
    expect(sharedSource).toContain("requestAnimationFrame");
    expect(sharedSource).toContain("ResizeObserver");
    expect(sharedSource).toContain("ownerRef.current.dispose");
    expect(sharedSource).toContain(".catch(() =>");
    expect(sharedSource).not.toContain("setInterval");
  });
});
