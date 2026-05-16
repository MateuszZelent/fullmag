import { describe, expect, it } from "vitest";

import {
  meshPipelineStatusIsActive,
  meshPipelineStatusTone,
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "./buildPipeline";

describe("mesh build pipeline model", () => {
  it("normalizes runtime pipeline arrays into display phases", () => {
    const phases = normalizeMeshPipelineStatus([
      { id: "import", label: "Import", status: "done" },
      {
        detail: "Gmsh: generating 3D tetrahedral mesh",
        id: "generate",
        label: "Generate",
        status: "running",
      },
    ]);

    expect(phases).toEqual([
      { detail: "", id: "import", label: "Import", status: "done" },
      {
        detail: "Gmsh: generating 3D tetrahedral mesh",
        id: "generate",
        label: "Generate",
        status: "running",
      },
    ]);
    expect(resolveMeshBuildStatusLabel(null, phases)).toBe("Generate: running");
    expect(meshPipelineStatusTone("Generate: running")).toBe("warning");
    expect(meshPipelineStatusIsActive("Generate: running")).toBe(true);
  });

  it("keeps legacy object status readable while rejecting empty records", () => {
    expect(
      normalizeMeshPipelineStatus({
        detail: "Queued by mesh command",
        phase: "queue",
        status: "queued",
      }),
    ).toEqual([
      {
        detail: "Queued by mesh command",
        id: "queue",
        label: "Queue",
        status: "queued",
      },
    ]);

    expect(normalizeMeshPipelineStatus({})).toEqual([]);
  });
});
