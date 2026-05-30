import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CrossSectionPlot } from "@/kernel/workspace/crossSectionWorkspace";

import {
  formatViewport2DPlotTabLabel,
  Viewport2DPlotTabs,
} from "./Viewport2DPlotTabs";

const plots: CrossSectionPlot[] = [
  {
    frameExtent: "universe",
    id: "plot-1",
    metric: "skewness",
    name: "Mid XY",
    plane: "xy",
    positionPercent: 50,
    qualityQuery: {
      metric: "skewness",
      plane: "xy",
      positionPercent: 50,
    },
    query: {
      includePolygons: true,
      includeWireframe: true,
      plane: "xy",
      positionPercent: 50,
    },
    renderOptions: {
      colorScale: "jet",
      frameRotationDegrees: 0,
      filterExpression: "",
      shrinkFactor: 1,
      wireframeVisible: true,
    },
    rotationDegrees: 0,
  },
  {
    frameExtent: "universe",
    id: "plot-2",
    metric: "aspect_ratio",
    name: "Interface cut",
    plane: "xz",
    positionPercent: 25,
    qualityQuery: {
      metric: "aspect_ratio",
      plane: "xz",
      positionPercent: 25,
    },
    query: {
      includePolygons: true,
      includeWireframe: false,
      plane: "xz",
      positionPercent: 25,
    },
    renderOptions: {
      colorScale: "viridis",
      frameRotationDegrees: 0,
      filterExpression: "quality < 0.3",
      shrinkFactor: 0.8,
      wireframeVisible: false,
    },
    rotationDegrees: 0,
  },
];

describe("Viewport2DPlotTabs", () => {
  it("renders committed cross-section plots as auxiliary viewport tabs", () => {
    const html = renderToStaticMarkup(
      <Viewport2DPlotTabs
        activePlotId="plot-2"
        plots={plots}
        onPlotSelect={vi.fn()}
      />,
    );

    expect(html).toContain("2D cross-section plots");
    expect(html).toContain("Mid XY");
    expect(html).toContain("XY 50% / skewness");
    expect(html).toContain("Interface cut");
    expect(html).toContain("XZ 25% / aspect_ratio");
    expect(html).toContain('data-state="active"');
  });

  it("formats stable compact labels for plot tabs", () => {
    expect(formatViewport2DPlotTabLabel(plots[1])).toBe(
      "XZ 25% / aspect_ratio",
    );
  });
});
