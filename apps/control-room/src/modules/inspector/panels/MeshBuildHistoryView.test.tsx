import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeMeshBuildHistory } from "@/shared/domain/mesh/meshBuildHistory";

import { MeshBuildHistoryView } from "./MeshBuildHistoryView";

describe("MeshBuildHistoryView", () => {
  it("renders build comparison deltas without raw JSON", () => {
    const entries = normalizeMeshBuildHistory([
      { mesh_name: "mesh-a", node_count: 10, element_count: 20 },
      {
        mesh_name: "mesh-b",
        node_count: 16,
        element_count: 28,
        mesh_reason: "adaptive_refine",
        quality: { gamma_min: 0.2, sicn_p5: 0.4 },
      },
    ]);

    const html = renderToStaticMarkup(
      <MeshBuildHistoryView entries={entries} />,
    );

    expect(html).toContain("mesh-b");
    expect(html).toContain("Compare builds");
    expect(html).toContain("Build #1 / Build #2");
    expect(html).toContain("Gamma min");
    expect(html).toContain("nodes +6");
    expect(html).toContain("elements +8");
    expect(html).toContain("adaptive_refine");
    expect(html).toContain("SICN p05 0.4");
    expect(html).not.toContain("mesh_reason");
  });

  it("renders controls for selecting an arbitrary build pair", () => {
    const entries = normalizeMeshBuildHistory([
      { mesh_name: "mesh-a", node_count: 10, element_count: 20 },
      { mesh_name: "mesh-b", node_count: 14, element_count: 26 },
      { mesh_name: "mesh-c", node_count: 21, element_count: 39 },
    ]);

    const html = renderToStaticMarkup(
      <MeshBuildHistoryView entries={entries} />,
    );

    expect(html).toContain("Compare builds");
    expect(html).toContain("From");
    expect(html).toContain("To");
    expect(html).toContain("#1 mesh-a");
    expect(html).toContain("#2 mesh-b");
    expect(html).toContain("#3 mesh-c");
    expect(html).toContain("Build #2 / Build #3");
  });
});
