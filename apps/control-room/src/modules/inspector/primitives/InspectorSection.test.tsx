import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FieldRow } from "./FieldRow";
import { InspectorSection } from "./InspectorSection";

describe("InspectorSection", () => {
  it("renders compact inspector sections with field rows and units", () => {
    const html = renderToStaticMarkup(
      <InspectorSection title="Geometry">
        <FieldRow label="Thickness" unit="nm" value="50" />
      </InspectorSection>,
    );

    expect(html).toContain('data-slot="inspector-group"');
    expect(html).not.toContain("fm-inspector-section");
    expect(html).toContain("Geometry");
    expect(html).toContain("Thickness");
    expect(html).toContain("50");
    expect(html).toContain("nm");
  });
});
