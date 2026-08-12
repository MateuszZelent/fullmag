import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
});
