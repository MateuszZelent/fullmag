import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EChartsCanvasSurface } from "./EChartsCanvasSurface";
import type { ChartRenderModel } from "./chartRenderer";

describe("EChartsCanvasSurface", () => {
  const dummyModel: ChartRenderModel = {
    ariaLabel: "Test chart",
    key: "test-key-123",
    provenance: {
      dataRevision: 1,
      decimation: "none",
      query: "select",
      resourceKey: "res:1",
    },
    series: [
      {
        id: "s1",
        kind: "line",
        label: "Series 1",
        points: [
          { rowIndex: 0, x: 0, y: 1 },
          { rowIndex: 1, x: 1, y: 2 },
        ],
        unit: "m",
        yAxis: 0,
      },
    ],
    status: "ready",
    xAxis: { label: "x", unit: "s" },
    yAxes: [{ label: "y", unit: "m" }],
  };

  it("renders surface container with aria-label and model key", () => {
    const html = renderToStaticMarkup(<EChartsCanvasSurface model={dummyModel} />);
    expect(html).toContain('aria-label="Test chart"');
    expect(html).toContain('data-chart-model-key="test-key-123"');
  });

  it("renders empty state overlay when series has no points", () => {
    const emptyModel: ChartRenderModel = {
      ...dummyModel,
      series: [{ ...dummyModel.series[0], points: [] }],
      status: "empty",
      statusMessage: "No samples available",
    };
    const html = renderToStaticMarkup(<EChartsCanvasSurface model={emptyModel} />);
    expect(html).toContain("No samples available");
    expect(html).toContain('role="status"');
  });

  it("renders error state overlay with role alert", () => {
    const errorModel: ChartRenderModel = {
      ...dummyModel,
      status: "error",
      statusMessage: "Resource failed to load",
    };
    const html = renderToStaticMarkup(<EChartsCanvasSurface model={errorModel} />);
    expect(html).toContain("Resource failed to load");
    expect(html).toContain('role="alert"');
  });
});
