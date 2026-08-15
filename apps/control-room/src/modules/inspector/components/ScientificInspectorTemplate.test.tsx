import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScientificInspectorTemplate } from "./ScientificInspectorTemplate";

describe("ScientificInspectorTemplate", () => {
  it("renders identity, independent statuses, SI properties, provenance, and diagnostics", () => {
    const html = renderToStaticMarkup(
      <ScientificInspectorTemplate
        breadcrumbs={["Results", "Resonance & FMR"]}
        diagnostics={["Observable contract unavailable"]}
        methodLabel="Modal eigensolve"
        physicalLabel="Resonance"
        properties={[{ label: "Frequency", unit: "Hz", value: "2.4e9" }]}
        provenance={[{ label: "Run", mono: true, value: "run-1" }]}
        status={{ availability: "available", execution: "completed", resource: "ready" }}
        title="Eigenfrequency Spectrum"
      />,
    );

    expect(html).toContain('aria-label="Scientific result path"');
    expect(html).toContain("Modal eigensolve");
    expect(html).toContain("Resource");
    expect(html).toContain("Execution");
    expect(html).toContain("Availability");
    expect(html).toContain("Hz");
    expect(html).toContain("run-1");
    expect(html).toContain("Observable contract unavailable");
  });

  it("keeps panel-specific content inside the shared scientific frame", () => {
    const html = renderToStaticMarkup(
      <ScientificInspectorTemplate
        methodLabel="Frequency-driven"
        physicalLabel="Driven resonance"
        status={{ availability: "available", execution: "completed", resource: "ready" }}
        title="Response spectrum"
      >
        <div data-inspector-surface="response-spectrum">Chart and response controls</div>
      </ScientificInspectorTemplate>,
    );

    expect(html).toContain('class="fm-scientific-inspector__content"');
    expect(html).toContain('data-inspector-surface="response-spectrum"');
    expect(html).toContain("Chart and response controls");
  });
});
