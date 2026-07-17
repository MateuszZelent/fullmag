import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ObjectVisualizationOverview } from "./ObjectVisualizationOverview";

describe("ObjectVisualizationOverview", () => {
  it("composes the reference overview without nested compatibility cards", () => {
    const html = renderToStaticMarkup(
      <ObjectVisualizationOverview
        advanced={<p>Advanced controls</p>}
        camera={<p>Camera follows viewport</p>}
        clipping={<p>No clipping plane</p>}
        dataState="Live"
        display={<button type="button">Visible</button>}
        enabledPassCount={4}
        meshState="Ready"
        quantitySource="m"
        surfaceColoring={<button type="button">Solid</button>}
        vectors={<button type="button">Vectors</button>}
      />,
    );

    expect(html).toContain('data-slot="object-visualization-overview"');
    expect(html).toContain('data-slot="inspector-metric-strip"');
    expect(html).toContain("4 enabled");
    expect(html).toContain("Quantity Source");
    expect(html).not.toContain("fm-inspector-section");
    expect(html).not.toMatch(/<(?:img|canvas)\b/i);
  });

  it("keeps advanced groups closed initially", () => {
    const html = renderToStaticMarkup(
      <ObjectVisualizationOverview
        advanced={<p>Advanced controls</p>}
        camera={<p>Camera follows viewport</p>}
        clipping={<p>No clipping plane</p>}
        dataState="Not required"
        display={<button type="button">Visible</button>}
        enabledPassCount={1}
        meshState="Degraded"
        quantitySource="H_eff"
        surfaceColoring={<button type="button">Solid</button>}
        vectors={<button type="button">Vectors</button>}
      />,
    );

    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
  });
});
