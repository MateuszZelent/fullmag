import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ScientificInspectorContext,
  ScientificInspectorIdentity,
  ScientificInspectorTemplate,
} from "./ScientificInspectorTemplate";

describe("ScientificInspectorTemplate", () => {
  it("renders identity separately from an optionally collapsed context", () => {
    const identity = renderToStaticMarkup(
      <ScientificInspectorIdentity
        breadcrumbs={["Model", "Visualization"]}
        methodLabel="Display controls"
        physicalLabel="Airbox"
        title="Airbox visualization"
      />,
    );
    const context = renderToStaticMarkup(
      <ScientificInspectorContext
        collapsible
        defaultOpen={false}
        properties={[{ label: "Target scope", value: "Airbox" }]}
        provenance={[{ label: "Target ID", value: "airbox" }]}
        status={{ availability: "available", execution: "interactive", resource: "ready" }}
      />,
    );

    expect(identity).toContain("Airbox visualization");
    expect(identity).toContain("Display controls");
    expect(context).toContain('data-collapsible="true"');
    expect(context).toContain('data-open="false"');
    expect(context).toContain("Status");
    expect(context).toContain("Provenance");
  });

  it("leaves identity to the Inspector shell unless asked", () => {
    const props = {
      breadcrumbs: ["Results", "Resonance & FMR"],
      methodLabel: "Modal eigensolve",
      physicalLabel: "Resonance",
      status: { availability: "available", execution: "completed", resource: "unknown" },
      title: "Eigenfrequency Spectrum",
    } as const;
    const nested = renderToStaticMarkup(<ScientificInspectorTemplate {...props} />);
    const standalone = renderToStaticMarkup(<ScientificInspectorTemplate {...props} showIdentity />);

    expect(nested).not.toContain('aria-label="Scientific result path"');
    expect(nested).not.toContain("<h3>Eigenfrequency Spectrum</h3>");
    expect(nested).toMatch(/Method<\/span><span[^>]*>Modal eigensolve</);
    const facts = nested.slice(0, nested.indexOf("</ul>"));
    expect(facts).not.toContain("unknown");
    expect(standalone).toContain('aria-label="Scientific result path"');
  });

  it("renders identity, independent statuses, SI properties, provenance, and diagnostics", () => {
    const html = renderToStaticMarkup(
      <ScientificInspectorTemplate
        showIdentity
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
