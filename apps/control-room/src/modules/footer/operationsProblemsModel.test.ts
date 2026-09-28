import { describe, expect, it } from "vitest";

import type {
  CommandQueueStatusResource,
  GeometryDiagnosticsResource,
  MeshActiveBuildResource,
  MeshLastSuccessfulBuildResource,
  SimulationPreparationResource,
} from "@/kernel/api/apiTypes";

import {
  buildOperationsProjection,
  buildProblemsProjection,
} from "./operationsProblemsModel";

const commandQueue: CommandQueueStatusResource = {
  accepted_count: 0,
  can_accept_commands: true,
  commands: [
    {
      command_id: "grid-12",
      completed_at_unix_ms: 12,
      completion_status: "completed",
      created_at_unix_ms: 10,
      kind: "fdm_grid_refresh",
      reason: "explicit_build_grid",
      seq: 12,
      status: "completed",
    },
    {
      command_id: "mesh-13",
      completed_at_unix_ms: 14,
      completion_status: "failed",
      created_at_unix_ms: 13,
      error: "candidate quality certificate rejected",
      kind: "mesh_build",
      seq: 13,
      status: "failed",
    },
  ],
  completed_count: 1,
  dispatched_count: 0,
  failed_count: 1,
  pending_count: 0,
  rejected_count: 0,
  revision: 13,
  running_count: 0,
  runtime_controls: [],
};

const preparation: SimulationPreparationResource = {
  active_stage_id: "meshing",
  completed_at_unix_ms: null,
  failure: null,
  log_tail: [],
  preparation_id: "prep-12",
  receipt: null,
  requested_execution: { backend: "fem", device: "cpu" },
  resolved_execution: { backend: "fem", device: "cpu" },
  revision: 21,
  stages: [
    {
      completed_at_unix_ms: null,
      detail: "Building shared-domain mesh",
      duration_ms: null,
      id: "meshing",
      label: "Mesh",
      progress_label: "Gmsh pass 2",
      progress_percent: null,
      started_at_unix_ms: 20,
      status: "active",
    },
  ],
  started_at_unix_ms: 20,
  status: "running",
};

const meshBuild = {
  active_build: null,
  last_build_error: "candidate quality certificate rejected",
  last_build_summary: {
    build_id: "mesh-good-7",
    mesh_name: "shared-domain",
    status: "completed",
  },
  mesh_pipeline_status: null,
  revision: 22,
} as unknown as MeshActiveBuildResource;

const latestSuccessfulMesh = {
  last_build_error: "candidate quality certificate rejected",
  last_success: {
    build_id: "mesh-good-7",
    mesh_name: "shared-domain",
    source_scene_revision: 12,
    status: "completed",
  },
  revision: 22,
  source_scene_revision: 12,
} as unknown as MeshLastSuccessfulBuildResource;

const geometryDiagnostics: GeometryDiagnosticsResource = {
  backend_target: "fem",
  diagnostics: [
    {
      blocks: ["mesh"],
      code: "GEOMETRY_SELF_INTERSECTION",
      geometry_path: "features/union-1",
      id: "geometry-1",
      message: "Union produced a self-intersection.",
      object_id: "body",
      severity: "error",
    },
    {
      code: "THIN_FEATURE",
      id: "geometry-2",
      message: "Thin feature may require local refinement.",
      severity: "warning",
    },
  ],
  scene_revision: 12,
  status: "invalid",
};

describe("operationsProblemsModel", () => {
  it("projects preparation, mesh, and commands without synthesizing progress", () => {
    const model = buildOperationsProjection({
      commandQueue,
      meshBuild,
      preparation,
    });

    expect(model.rows.map((row) => row.id)).toEqual([
      "preparation:prep-12",
      "mesh:mesh-good-7",
      "command:mesh-13",
      "command:grid-12",
    ]);
    expect(model.rows[0]).toMatchObject({
      detail: "Gmsh pass 2",
      revision: "21",
      status: "running",
    });
    expect(model.rows.every((row) => !("progressPercent" in row))).toBe(true);
  });

  it("projects source diagnostics and preserves last-good mesh identity", () => {
    const model = buildProblemsProjection({
      commandQueue,
      geometryDiagnostics,
      latestSuccessfulMesh,
      meshBuild,
      preparation,
    });

    expect(model).toMatchObject({ errorCount: 3, warningCount: 1 });
    expect(
      model.rows.find((row) => row.code === "MESH_BUILD_FAILED"),
    ).toMatchObject({
      detail: "Last good: mesh-good-7; scene revision 12",
      message: "candidate quality certificate rejected",
    });
    expect(model.rows.map((row) => row.code)).toContain(
      "GEOMETRY_SELF_INTERSECTION",
    );
    expect(model.rows.map((row) => row.code)).toContain("COMMAND_FAILED");
  });

  it("reports projection gaps separately from domain problems", () => {
    const model = buildProblemsProjection({
      commandQueue: null,
      geometryDiagnostics: null,
      latestSuccessfulMesh: null,
      meshBuild: null,
      preparation: null,
      resources: [
        {
          error: new Error("request failed"),
          label: "Geometry diagnostics",
          status: "error",
        },
      ],
    });

    expect(model.rows).toEqual([]);
    expect(model.gaps).toEqual(["Geometry diagnostics: request failed"]);
  });
});
