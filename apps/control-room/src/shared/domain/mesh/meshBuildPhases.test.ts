import { describe, expect, it } from "vitest";

import {
  CANONICAL_MESH_BUILD_PHASES,
  meshBuildPhaseStatusIsActive,
  normalizeMeshBuildPhases,
  resolveMeshBuildTerminalStatus,
} from "./meshBuildPhases";

describe("mesh build phases", () => {
  it("renders every canonical phase and appends unknown backend phases", () => {
    const phases = normalizeMeshBuildPhases([
      {
        id: "gmsh_meshing",
        label: "Gmsh",
        progress_percent: 66.4,
        status: "running",
      },
      {
        id: "backend_pack",
        label: "Pack backend payload",
        status: "completed",
      },
    ]);

    expect(phases.map((phase) => phase.id)).toEqual([
      ...CANONICAL_MESH_BUILD_PHASES.map((phase) => phase.id),
      "backend_pack",
    ]);
    expect(phases.find((phase) => phase.id === "queued")?.status).toBe(
      "pending",
    );
    expect(phases.find((phase) => phase.id === "gmsh_meshing")).toMatchObject({
      label: "Gmsh",
      progressPercent: 66,
      status: "running",
    });
    expect(phases.at(-1)).toMatchObject({
      id: "backend_pack",
      label: "Pack backend payload",
      status: "completed",
    });
  });

  it("resolves terminal status from normalized phases", () => {
    expect(
      resolveMeshBuildTerminalStatus(
        normalizeMeshBuildPhases([{ id: "gmsh_meshing", status: "failed" }]),
      ),
    ).toBe("failed");

    expect(
      resolveMeshBuildTerminalStatus(
        normalizeMeshBuildPhases(
          CANONICAL_MESH_BUILD_PHASES.map((phase) => ({
            id: phase.id,
            status: "completed",
          })),
        ),
      ),
    ).toBe("completed");

    expect(resolveMeshBuildTerminalStatus(normalizeMeshBuildPhases([]))).toBe(
      "unknown",
    );
  });

  it("treats active statuses as active only after ordered work has started", () => {
    const phases = normalizeMeshBuildPhases([
      { id: "queued", status: "queued" },
      { id: "scene_snapshot", status: "pending" },
    ]);

    expect(meshBuildPhaseStatusIsActive(phases[0], 0, phases)).toBe(true);
    expect(meshBuildPhaseStatusIsActive(phases[1], 1, phases)).toBe(false);
  });
});
