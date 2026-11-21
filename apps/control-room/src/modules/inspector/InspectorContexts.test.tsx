import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InspectorContexts } from "./InspectorContexts";

describe("InspectorContexts", () => {
  it("keeps the selection tree mounted but hidden while editing the view", () => {
    const html = renderToStaticMarkup(
      <InspectorContexts
        context="view"
        exportPanel={<p>Export options</p>}
        onContextChange={() => undefined}
        view={<p>View settings</p>}
      >
        <input defaultValue="Unapplied object draft" />
      </InspectorContexts>,
    );
    expect(html).toContain('value="Unapplied object draft"');
    expect(html).not.toContain('aria-label="Inspector context"');
    expect(html).toMatch(/data-state="inactive"[^>]*hidden=""[^>]*>[\s\S]*Unapplied object draft/);
    expect(html).toContain("View settings");
  });

  it("shows the export context while keeping selection and view mounted", () => {
    const html = renderToStaticMarkup(
      <InspectorContexts
        context="export"
        exportPanel={<p>Export PNG or 3D</p>}
        onContextChange={() => undefined}
        view={<p>View settings</p>}
        viewActions={<span>Export</span>}
      >
        <input defaultValue="Unapplied object draft" />
      </InspectorContexts>,
    );
    expect(html).toContain('value="Unapplied object draft"');
    expect(html).toContain("View settings");
    expect(html).toContain("Export PNG or 3D");
    expect(html).toContain("fm-inspector-contexts__header");
  });
});
