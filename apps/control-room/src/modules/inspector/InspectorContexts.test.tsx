import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InspectorContexts } from "./InspectorContexts";

describe("InspectorContexts", () => {
  it("keeps the selection tree mounted but hidden while editing the view", () => {
    const html = renderToStaticMarkup(<InspectorContexts context="view" onContextChange={() => undefined} view={<p>View settings</p>}><input defaultValue="Unapplied object draft" /></InspectorContexts>);
    expect(html).toContain('value="Unapplied object draft"');
    expect(html).toContain('aria-label="Inspector context"');
    expect(html).toMatch(/data-state="inactive"[^>]*hidden=""[^>]*>[\s\S]*Unapplied object draft/);
    expect(html).toContain("View settings");
  });
});
