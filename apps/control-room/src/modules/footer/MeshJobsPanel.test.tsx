import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MeshJobsModel } from "./meshJobsModel";
import { MeshJobsPanelView } from "./MeshJobsPanel";

describe("MeshJobsPanel", () => {
  it("renders all production mesh job sections", () => {
    const model: MeshJobsModel = {
      activeTitle: "Running study_domain mesh build",
      historyRows: [
        {
          id: "mesh-history-test-1",
          elements: "120",
          mesh: "mesh-2",
          nodes: "80",
          reason: "shared-domain",
          target: "study_domain",
        },
      ],
      latestRows: [{ label: "Scene revision", value: "7" }],
      logRows: [
        {
          level: "info",
          message: "Gmsh: generating 3D tetrahedral mesh",
          time: "00:00:02",
        },
      ],
      phaseRows: [
        {
          detail: "Gmsh",
          durationMs: null,
          id: "gmsh_meshing",
          label: "Gmsh Meshing",
          progressLabel: null,
          progressPercent: 50,
          status: "running",
        },
      ],
      publishedRows: [{ label: "Mesh revision", value: "42" }],
      viewportRows: [{ label: "Rendered mesh revision", value: "42" }],
    };

    const html = renderToStaticMarkup(
      <MeshJobsPanelView
        activeStatus="ready"
        historyCount={1}
        model={model}
      />,
    );

    expect(html).toContain("Active Build");
    expect(html).toContain("Pipeline");
    expect(html).toContain("Published Output");
    expect(html).toContain("Latest Success");
    expect(html).toContain("Build History");
    expect(html).toContain("Viewport Delivery");
    expect(html).toContain("Build Log");
    expect(html).toContain("Mesh build log filters");
    expect(html).toContain("Copy visible log");
    expect(html).toContain("Gmsh: generating 3D tetrahedral mesh");
  });
});
