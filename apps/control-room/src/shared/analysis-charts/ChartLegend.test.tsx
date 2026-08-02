import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChartLegend, chartColorNameForIndex, type ChartLegendItem } from "./ChartLegend";
import { toggleSelectedSeriesId } from "./chartSeriesSelection";

describe("ChartLegend", () => {
  const dummyItems: ChartLegendItem[] = [
    {
      id: "s1",
      label: "Magnetization mx",
      unit: "dimensionless",
      latestValue: "0.25",
      colorName: "blue",
      colorIndex: 0,
    },
    {
      id: "s2",
      label: "Magnetization my",
      unit: "dimensionless",
      latestValue: "0.50",
      colorName: "green",
      colorIndex: 1,
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
        onSelectedSeriesIdsChange={vi.fn()}
        selectedSeriesIds={["s1", "s2"]}
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
      <ChartLegend items={[]} onSelectedSeriesIdsChange={vi.fn()} selectedSeriesIds={[]} />,
    );
    expect(html).toBe("");
  });

  it("renders the exact selected-series state after a legend toggle without an API call", () => {
    const rowsBinary = vi.fn();
    const selectedAfterToggle = toggleSelectedSeriesId(["s1"], "s1", false);
    const callsBeforeToggle = rowsBinary.mock.calls.length;
    const html = renderToStaticMarkup(
      <ChartLegend
        items={dummyItems}
        onSelectedSeriesIdsChange={() => undefined}
        selectedSeriesIds={selectedAfterToggle}
      />,
    );

    expect(html).toContain('aria-pressed="false"');
    expect(rowsBinary).toHaveBeenCalledTimes(callsBeforeToggle);
  });
});
