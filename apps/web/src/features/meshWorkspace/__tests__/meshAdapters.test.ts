import { describe, expect, it } from "vitest";

import type { MeshSemanticsResource } from "../../../api/types";
import {
  buildMeshDirtyState,
  buildMeshWorkspaceModel,
  meshBuildProjectionFromRecord,
  meshSemanticsResourceToView,
} from "../meshAdapters";

describe("meshSemanticsResourceToView", () => {
  it("maps three-level mesh semantics payload to UI view model", () => {
    const resource: MeshSemanticsResource = {
      revision: 73,
      universe_config: {
        mode: "box",
        size: [4, 5, 6],
        padding: [1, 1.5, 2],
        airbox_hmax: 8e-9,
      },
      shared_domain_config: {
        algorithm_2d: 6,
        algorithm_3d: 10,
      },
      object_configs: [
        {
          object_id: "body",
          object_name: "body",
          config: {
            mode: "override",
            hmax: "2e-9",
            hmin: "5e-10",
          },
        },
      ],
      solver_mesh: {
        mesh_name: "mesh-a",
        mesh_id: "mesh-a:1",
        generation_id: "42",
        domain_mesh_mode: "shared_domain",
        object_segment_count: 1,
        mesh_part_count: 2,
      },
      mesh_build_diagnostics: {
        mesh_quality_summary: { min_quality: 0.82 },
        last_build_summary: { elements: 24 },
        mesh_pipeline_status: [{ id: "meshing", status: "active" }],
        last_build_error: "quality threshold not met",
      },
      render_only_controls_do_not_change_solver_domain: true,
    };

    const view = meshSemanticsResourceToView(resource);
    expect(view).not.toBeNull();
    expect(view?.revision).toBe(73);
    expect(view?.universe?.mode).toBe("box");
    expect(view?.universe?.size).toEqual([4, 5, 6]);
    expect(view?.objects[0].object_id).toBe("body");
    expect(view?.objects[0].mode).toBe("override");
    expect(view?.objects[0].hmax).toBe(2e-9);
    expect(view?.solver_mesh?.mesh_name).toBe("mesh-a");
    expect(view?.diagnostics?.min_quality).toBe(0.82);
    expect(view?.diagnostics?.pipeline_phase_count).toBe(1);
    expect(view?.render_only_controls_do_not_change_solver_domain).toBe(true);
  });

  it("returns null for missing payload", () => {
    expect(meshSemanticsResourceToView(null)).toBeNull();
    expect(meshSemanticsResourceToView(undefined)).toBeNull();
  });

  it("projects mesh build records into the staged build vocabulary", () => {
    expect(
      meshBuildProjectionFromRecord(
        {
          build_id: "build-1",
          status: "completed",
          created_at_unix_ms: 10,
          finished_at_unix_ms: 20,
          trigger: "sync",
          summary: "ok",
        },
        "fallback",
      ),
    ).toMatchObject({
      id: "build-1",
      state: "succeeded",
      requestedAtUnixMs: 10,
      finishedAtUnixMs: 20,
      trigger: "sync",
      summary: "ok",
    });
  });

  it("computes deterministic dirty state from revisions and last success", () => {
    const dirty = buildMeshDirtyState({
      sceneRevision: 12,
      meshRevision: 9,
      lastSuccessfulBuild: {
        id: "mesh-9",
        state: "succeeded",
        requestedAtUnixMs: 1,
        startedAtUnixMs: null,
        finishedAtUnixMs: 2,
        trigger: "manual",
        summary: null,
        raw: { revision: 9 },
      },
      hasUniverseConfig: true,
      hasSharedDomainConfig: true,
    });
    expect(dirty.isDirty).toBe(true);
    expect(dirty.reasons).toEqual(["scene_changed"]);
    expect(dirty.recommendedAction).toBe("rebuild_recommended");
  });

  it("builds a MeshWorkspaceModel from resource-family payloads", () => {
    const model = buildMeshWorkspaceModel({
      resources: {
        domain_generation_id: 3,
        fields_revision: 4,
        scalars_revision: 5,
        display_revision: 6,
        mesh_revision: 7,
        mesh_build_revision: 8,
        scene_revision: 7,
      },
      liveCapabilities: {
        structured_grid: false,
        explicit_topology: true,
        binary_fields: true,
        cell_fields: true,
        node_fields: true,
        scalar_history: true,
        eigen_modes: false,
        gpu_telemetry: false,
        preview_2d: true,
        preview_3d: true,
        algorithms_available: [],
      },
      summary: { revision: 7, mesh_summary: { elements: 10 } },
      semantics: {
        revision: 7,
        universe_config: { mode: "box" },
        shared_domain_config: { algorithm_3d: 10 },
        object_configs: [
          { object_id: "body", object_name: "body", config: { hmax: 1 } },
        ],
        solver_mesh: null,
        mesh_build_diagnostics: null,
        render_only_controls_do_not_change_solver_domain: true,
      },
      activeBuild: { revision: 8, active_build: { build_id: "active", status: "running" } },
      buildHistory: { revision: 8, history: [{ build_id: "old", status: "succeeded" }] },
      lastSuccessfulBuild: {
        revision: 8,
        last_success: { build_id: "old", status: "succeeded", revision: 7 },
      },
      manifest: {
        revision: 7,
        mesh_name: "mesh-a",
        mesh_id: "mesh-a:1",
        generation_id: "g1",
        object_segments: [],
        mesh_parts: [],
      },
    });

    expect(model.activeBuild?.state).toBe("running");
    expect(model.objectConfigs.body.object_id).toBe("body");
    expect(model.capabilityGates.explicit_topology.enabled).toBe(true);
    expect(model.sharedDomainManifest?.meshName).toBe("mesh-a");
    expect(model.diagnostics.status).toBe("building");
  });
});
