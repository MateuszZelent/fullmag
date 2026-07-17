import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InspectorGroup } from "./InspectorGroup";
import { InspectorMetricStrip } from "./InspectorMetricStrip";
import {
  InspectorPropertyGrid,
  InspectorPropertyRow,
} from "./InspectorPropertyRow";

describe("Inspector composition primitives", () => {
  it("renders a border-light semantic group without compatibility cards", () => {
    const html = renderToStaticMarkup(
      <InspectorGroup title="Display" description="Viewport-local controls">
        <button type="button">Visible</button>
      </InspectorGroup>,
    );

    expect(html).toContain("<section");
    expect(html).toContain('data-slot="inspector-group"');
    expect(html).toContain("<h3");
    expect(html).toContain("Display</h3>");
    expect(html).not.toContain("fm-inspector-section");
    expect(html).not.toContain("shadow-");
  });

  it("renders disclosure groups as native keyboard buttons", () => {
    const html = renderToStaticMarkup(
      <InspectorGroup collapsible defaultOpen={false} title="Vectors">
        Vector controls
      </InspectorGroup>,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-slot="inspector-group-trigger"');
    expect(html).toContain('data-slot="inspector-group-content" hidden=""');
  });

  it("associates a property row label with its control group", () => {
    const html = renderToStaticMarkup(
      <InspectorPropertyGrid>
        <InspectorPropertyRow
          description="Canonical magnetization field"
          label="Quantity source"
          unit="A/m"
        >
          <button type="button">m</button>
        </InspectorPropertyRow>
      </InspectorPropertyGrid>,
    );

    expect(html).toContain('data-slot="inspector-property-grid"');
    expect(html).toContain('data-slot="inspector-property-row"');
    expect(html).toContain('data-slot="inspector-property-control"');
    expect(html).toContain('role="group"');
    expect(html).toContain("Quantity source");
    expect(html).toContain("A/m");
  });

  it("renders a non-interactive strip of two or four metrics", () => {
    const html = renderToStaticMarkup(
      <InspectorMetricStrip
        metrics={[
          { label: "Display Passes", value: "4 enabled" },
          { label: "Quantity Source", value: "m" },
          { label: "Mesh Readiness", tone: "success", value: "Ready" },
          { label: "Data State", tone: "degraded", value: "Stale" },
        ]}
      />,
    );

    expect(html).toContain('data-slot="inspector-metric-strip"');
    expect(html.match(/data-slot="inspector-metric"/g)).toHaveLength(4);
    expect(html).not.toContain("role=\"button\"");
    expect(html).not.toContain("fm-inspector-summary-tile");
  });
});
