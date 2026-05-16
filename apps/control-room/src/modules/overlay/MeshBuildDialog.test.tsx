import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";

import { MeshBuildLogView, MeshBuildPipelineView } from "./MeshBuildDialog";

describe("MeshBuildDialog", () => {
  it("renders mesh pipeline arrays as build phases instead of falling back to idle JSON", () => {
    const phases = normalizeMeshPipelineStatus([
      {
        detail: "Inline/generated geometry",
        id: "import",
        label: "Import",
        status: "done",
      },
      {
        detail: "Gmsh: generating 3D tetrahedral mesh",
        duration_ms: 420,
        id: "generate",
        label: "Generate",
        progress_label: "generating 3D mesh",
        progress_percent: 75,
        status: "running",
      },
    ]);

    expect(resolveMeshBuildStatusLabel(null, phases)).toBe("Generate: running");

    const html = renderToStaticMarkup(
      <MeshBuildPipelineView
        buildReport={{ build_mode: "component_aware" }}
        lastSummary={{ elements: 42 }}
        phases={phases}
      />,
    );

    expect(html).toContain("Build pipeline");
    expect(html).toContain("75%");
    expect(html).toContain("duration 420 ms");
    expect(html).toContain("generating 3D mesh");
    expect(html).toContain("Generate");
    expect(html).toContain("running");
    expect(html).toContain("Gmsh: generating 3D tetrahedral mesh");
    expect(html).toContain("component_aware");
    expect(html).not.toContain("mesh_pipeline_status");
  });

  it("renders mesh-related engine log lines as the build console stream", () => {
    const html = renderToStaticMarkup(
      <MeshBuildLogView
        entries={[
          {
            level: "info",
            message: "Gmsh: generating 3D tetrahedral mesh",
            timestamp_unix_ms: 1_778_780_000_100,
          },
          {
            level: "debug",
            message: "API request completed",
            timestamp_unix_ms: 1_778_780_000_200,
          },
          {
            level: "success",
            message: "Remesh complete - 100 nodes, 200 elements",
            timestamp_unix_ms: 1_778_780_000_300,
          },
        ]}
        status="ready"
        total={3}
      />,
    );

    expect(html).toContain("Build console");
    expect(html).toContain("2 / 3 entries");
    expect(html).toContain("Gmsh: generating 3D tetrahedral mesh");
    expect(html).toContain("Remesh complete - 100 nodes, 200 elements");
    expect(html).not.toContain("API request completed");
  });
});
