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
      { duration_ms: 12, id: "import", label: "Import", status: "done" },
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

    expect(phases).toEqual([
      {
        detail: "",
        durationMs: 12,
        id: "import",
        label: "Import",
        progressLabel: null,
        progressPercent: null,
        status: "done",
      },
      {
        detail: "Gmsh: generating 3D tetrahedral mesh",
        durationMs: 420,
        id: "generate",
        label: "Generate",
        progressLabel: "generating 3D mesh",
        progressPercent: 75,
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
        durationMs: null,
        id: "queue",
        label: "Queue",
        progressLabel: null,
        progressPercent: null,
        status: "queued",
      },
    ]);

    expect(normalizeMeshPipelineStatus({})).toEqual([]);
  });
});
