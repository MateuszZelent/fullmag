import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";

import { MeshBuildPipelineView } from "./MeshBuildDialog";

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
        id: "generate",
        label: "Generate",
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
    expect(html).toContain("50%");
    expect(html).toContain("Generate");
    expect(html).toContain("running");
    expect(html).toContain("Gmsh: generating 3D tetrahedral mesh");
    expect(html).toContain("component_aware");
    expect(html).not.toContain("mesh_pipeline_status");
  });
});
