import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveInspectorRoute } from "../../inspectorRouteCatalog";
import { PhysicsFirstResultInspectorPanel } from "./PhysicsFirstResultInspectorPanel";

describe("PhysicsFirstResultInspectorPanel", () => {
  it("shows the owned dataset identity for a postprocessing definition", () => {
    const html = renderToStaticMarkup(
      <PhysicsFirstResultInspectorPanel
        selection={{
          kind: "results.tables.definition",
          label: "Selected modes",
          moduleSource: "explorer",
          nodeId: "results:run:run-7:tables:selected-modes",
          objectId: null,
          ref: {
            kind: "results.tables.definition",
            nodeId: "results:run:run-7:tables:selected-modes",
            resourceRef: "dataset://run-7/modes",
            type: "frequency-domain",
          },
        }}
      />,
    );

    expect(html).toContain("Dataset / resource");
    expect(html).toContain("dataset://run-7/modes");
  });

  it("explains the postprocessing owner contract gap and exposes no actions", () => {
    const route = resolveInspectorRoute("results.analysis_views.definition");
    expect(route).not.toBeNull();
    const selection = {
      kind: "results.analysis_views.definition",
      label: "Energy view",
      moduleSource: "explorer",
      nodeId: "results:run:run-7:analysis-views:view-1",
      objectId: null,
      ref: {
        kind: "results.analysis_views.definition",
        nodeId: "results:run:run-7:analysis-views:view-1",
        type: "frequency-domain",
      },
    } as const;
    const html = renderToStaticMarkup(
      createElement(route!.component, { selection }),
    );

    expect(html).toContain("No persistent owner resource is published for user-defined postprocessing definitions.");
    expect(html).toContain("unavailable");
    expect(html).not.toContain("data-slot=\"inspector-overview-actions\"");
  });
});
