import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanarColorLegend } from "./PlanarColorLegend";

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
});
