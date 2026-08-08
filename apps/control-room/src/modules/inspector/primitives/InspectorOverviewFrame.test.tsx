import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InspectorOverviewFrame } from "./InspectorOverviewFrame";

describe("InspectorOverviewFrame", () => {
  it("renders the visualization composition with a primary card and navigation sections", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewFrame
        actions={<button type="button">Apply</button>}
        className="fm-physics-inspector-overview"
        metrics={[
          { label: "Scope", value: "Object" },
          { label: "Source", value: "current" },
          { label: "Lane", value: "FEM", tone: "success" },
          { label: "Status", value: "Ready", tone: "success" },
        ]}
        primary={<p>Current source controls</p>}
        primaryTitle="Drive"
        sections={[
          {
            content: <p>Object scope</p>,
            id: "scope",
            title: "Scope",
            summary: "Object",
          },
          {
            content: <p>Dependency status</p>,
            defaultOpen: false,
            id: "dependency",
            title: "Dependency",
          },
        ]}
      />,
    );

    expect(html).toContain('data-slot="inspector-overview-frame"');
    expect(html).toContain('data-slot="inspector-metric-strip"');
    expect(html).toContain("Current source controls");
    expect(html).toContain("Object scope");
    expect(html).toContain("Apply");
    expect(html).toContain("fm-physics-inspector-overview");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("fm-inspector-section");
  });

  it("keeps the primary group open and uses token-backed navigation classes", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewFrame
        metrics={[
          { label: "Scope", value: "Global" },
          { label: "Source", value: "none" },
        ]}
        primary={<p>No module selected</p>}
        sections={[]}
      />,
    );

    expect(html).toContain('data-variant="primary"');
    expect(html).toContain("fm-inspector-overview-frame__primary");
    expect(html).toContain("No module selected");
  });
});
