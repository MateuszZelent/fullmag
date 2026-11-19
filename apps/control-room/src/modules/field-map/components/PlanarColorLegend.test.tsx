import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanarColorLegend, PlanarLayerLegendList, type PlanarLayerLegendEntry } from "./PlanarColorLegend";

describe("PlanarColorLegend", () => {
  it("renders the scalar identity, horizontal viridis ramp, and display-unit limits", () => {
    const html = renderToStaticMarkup(
      <PlanarColorLegend
        colormap="viridis"
        component="magnitude"
        legendUnit="kA/m"
        probeScale={1e-3}
        quantityId="m"
        range={{ max: 2_000, min: -1_000 }}
      />,
    );

    expect(html).toContain('aria-label="Scalar color range"');
    expect(html).toContain("Rendered range");
    expect(html).toContain("-1 kA/m");
    expect(html).toContain("2 kA/m");
    expect(html).toContain('data-colormap="viridis"');
    expect(html).toContain("linear-gradient(to right");
  });

  it("renders one compact card per drawn layer and hides the stack with the legend toggle", () => {
    const layers: PlanarLayerLegendEntry[] = [
      { id: "object:film", colormap: "hsl_direction", component: "magnitude", legendUnit: "1", probeScale: 1, quantityId: "m", range: null, targetLabel: "film" },
      { id: "airbox", colormap: "viridis", component: "magnitude", legendUnit: "A/m", probeScale: 1, quantityId: "H_demag", range: { min: 0, max: 1 }, targetLabel: "Airbox" },
    ];
    const html = renderToStaticMarkup(<PlanarLayerLegendList layers={layers} visible />);
    expect(html.match(/fm-field-map__colorbar--compact/g)).toHaveLength(2);
    expect(html.indexOf("film")).toBeLessThan(html.indexOf("Airbox"));
    expect(html).not.toContain("Hue: angle in XY");
    expect(renderToStaticMarkup(<PlanarLayerLegendList layers={layers} visible={false} />)).toBe("");
  });
});
