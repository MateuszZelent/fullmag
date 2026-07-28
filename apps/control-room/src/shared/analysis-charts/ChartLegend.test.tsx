import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChartLegend, chartColorNameForIndex, type ChartLegendItem } from "./ChartLegend";

describe("ChartLegend", () => {
  const dummyItems: ChartLegendItem[] = [
    {
      id: "s1",
      label: "Magnetization mx",
      unit: "dimensionless",
      latestValue: "0.25",
      colorName: "blue",
      colorIndex: 0,
      hidden: false,
      soloed: false,
    },
    {
      id: "s2",
      label: "Magnetization my",
      unit: "dimensionless",
      latestValue: "0.50",
      colorName: "green",
      colorIndex: 1,
      hidden: false,
      soloed: false,
    },
  ];

  it("chartColorNameForIndex cycles through 12 palette colors", () => {
    expect(chartColorNameForIndex(0)).toBe("blue");
    expect(chartColorNameForIndex(1)).toBe("green");
    expect(chartColorNameForIndex(12)).toBe("blue");
  });

  it("renders series buttons with aria-pressed, swatches, labels, and latest values", () => {
    const html = renderToStaticMarkup(
      <ChartLegend
        items={dummyItems}
        onToggleVisibility={vi.fn()}
        onSolo={vi.fn()}
      />,
    );

    expect(html).toContain("Magnetization mx");
    expect(html).toContain("0.25");
    expect(html).toContain("Magnetization my");
    expect(html).toContain("0.50");
    expect(html).toContain("fm-chart-legend__swatch--blue");
    expect(html).toContain("fm-chart-legend__swatch--green");
    expect(html).toContain('data-slot="chart-legend-unit"');
    expect(html).toContain('data-slot="chart-legend-reading"');
    expect(html).not.toContain("[dimensionless]");
  });

  it("returns null when items array is empty", () => {
    const html = renderToStaticMarkup(
      <ChartLegend items={[]} onToggleVisibility={vi.fn()} onSolo={vi.fn()} />,
    );
    expect(html).toBe("");
  });
});
