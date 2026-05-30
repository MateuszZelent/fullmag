import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  colorbarGradient,
  Viewport2DColorbar,
} from "./Viewport2DColorbar";

describe("Viewport2DColorbar", () => {
  it("renders a labeled quality legend for the active color scale", () => {
    const html = renderToStaticMarkup(
      <Viewport2DColorbar
        colorScale="jet"
        metric="skewness"
        range={{ min: 0.2, max: 0.8 }}
      />,
    );

    expect(html).toContain("skewness color scale from 0.2 to 0.8");
    expect(html).toContain("skewness");
    expect(html).toContain("jet");
    expect(html).toContain("0.2");
    expect(html).toContain("0.5");
    expect(html).toContain("0.8");
    expect(html).toContain("linear-gradient");
  });

  it("builds gradients from the shared viewport quality color mapping", () => {
    const gradient = colorbarGradient("hot", { min: 0, max: 1 });

    expect(gradient).toMatch(/^linear-gradient\(90deg, /);
    expect(gradient).toContain("0%");
    expect(gradient).toContain("50%");
    expect(gradient).toContain("100%");
  });
});
