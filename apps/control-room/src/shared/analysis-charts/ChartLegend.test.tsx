import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
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
        onSelectedSeriesIdsChange={() => undefined}
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
      <ChartLegend items={[]} onSelectedSeriesIdsChange={() => undefined} selectedSeriesIds={[]} />,
    );
    expect(html).toBe("");
  });

  it("updates the authoritative selection through the legend click handler", () => {
    let received: string[] | null = null;
    const legend = ChartLegend({
      items: dummyItems,
      onSelectedSeriesIdsChange: (next) => {
        received = next;
      },
      selectedSeriesIds: ["s1"],
    }) as ReactElement<{
      children: ReactElement<{ onClick: (event: { shiftKey: boolean }) => void }>[];
    }>;
    const firstButton = legend.props.children[0]!;

    firstButton.props.onClick({ shiftKey: false });

    expect(received).toEqual([]);
  });
});
