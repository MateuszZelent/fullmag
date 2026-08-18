import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  VisualizationDisplayPassesControl,
  VisualizationRenderModeControl,
} from "./VisualizationInspectorControls";

describe("shared visualization Inspector controls", () => {
  it("renders the canonical render modes in the same accessible order for every renderer", () => {
    const html = renderToStaticMarkup(
      <VisualizationRenderModeControl
        disabled={false}
        options={["surface", "surface+edges", "wireframe", "points", "off"]}
        value="surface"
        onValueChange={vi.fn()}
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Render mode"');
    expect(html.indexOf('aria-label="Shaded"')).toBeLessThan(
      html.indexOf('aria-label="Shaded + Wireframe"'),
    );
    expect(html.indexOf('aria-label="Shaded + Wireframe"')).toBeLessThan(
      html.indexOf('aria-label="Wireframe"'),
    );
    expect(html.indexOf('aria-label="Wireframe"')).toBeLessThan(
      html.indexOf('aria-label="Points"'),
    );
    expect(html.indexOf('aria-label="Points"')).toBeLessThan(
      html.indexOf('aria-label="Off"'),
    );
    expect(html).toContain("fm-viz-render-mode-tile--active");
  });

  it("renders one shared pass strip with pressed and disabled state", () => {
    const html = renderToStaticMarkup(
      <VisualizationDisplayPassesControl
        items={[
          { id: "visible", label: "Visible", pressed: true, onToggle: vi.fn() },
          { id: "vectors", label: "Vectors", pressed: false, disabled: true, onToggle: vi.fn() },
        ]}
      />,
    );

    expect(html).toContain('data-slot="visualization-display-passes"');
    expect(html).toContain('aria-label="Toggle Visible"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Toggle Vectors"');
    expect(html).toContain("disabled");
  });
});
