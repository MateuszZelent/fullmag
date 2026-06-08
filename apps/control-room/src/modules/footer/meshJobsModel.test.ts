import { describe, expect, it } from "vitest";

import {
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
} from "@/kernel/api/apiPaths";

import { buildMeshJobsModel } from "./meshJobsModel";

describe("meshJobsModel", () => {
  it("builds a persistent mesh job summary from resources and engine log", () => {
    const model = buildMeshJobsModel({
      activeBuild: {
        mesh_pipeline_status: [
          { id: "queued", status: "completed" },
          {
            id: "gmsh_meshing",
            progress_percent: 50,
            status: "running",
          },
        ],
        published_resources: {
          manifest: MESHING_SHARED_DOMAIN_MANIFEST_PATH,
          mesh_build_revision: 57,
          mesh_revision: 42,
          quality: MESHING_SHARED_DOMAIN_QUALITY_PATH,
          realized_size_fields: MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
        },
        status: "running",
        target: { kind: "study_domain" },
      },
      engineLog: {
        entries: [
          {
            level: "info",
            message: "solver heartbeat",
            timestamp_unix_ms: 1000,
          },
          {
            command_id: "cmd-1",
            level: "info",
            message: "Gmsh: generating 3D tetrahedral mesh",
            phase_id: "gmsh_meshing",
            source: "gmsh",
            timestamp_unix_ms: 2000,
          } as never,
        ],
        total: 2,
      },
      latestSuccessfulBuild: {
        build_report: { element_count: 120 },
        source_scene_revision: 7,
      },
      loadedMeshRevision: 42,
      history: {
        history: [
          {
            element_count: 90,
            mesh_name: "mesh-1",
            mesh_reason: "selected-object",
            mesh_target: "object_mesh",
            node_count: 50,
          },
          {
            element_count: 120,
            mesh_name: "mesh-2",
            mesh_reason: "shared-domain",
            mesh_target: "study_domain",
            node_count: 80,
          },
        ],
      },
      viewportConfirmation: {
        meshRevision: 42,
        rendererId: "viewport-3d",
      },
    });

    expect(model.activeTitle).toBe("Running study_domain mesh build");
    expect(model.phaseRows.find((row) => row.id === "gmsh_meshing")).toMatchObject({
      progressPercent: 50,
      status: "running",
    });
    expect(model.logRows).toEqual([
      {
        commandId: "cmd-1",
        level: "info",
        message: "Gmsh: generating 3D tetrahedral mesh",
        phaseId: "gmsh_meshing",
        source: "gmsh",
        time: "00:00:02",
      },
    ]);
    expect(model.latestRows).toContainEqual({
      label: "Scene revision",
      value: "7",
    });
    expect(model.publishedRows).toContainEqual({
      label: "Mesh revision",
      value: "42",
    });
    expect(model.historyRows).toEqual([
      {
        id: "mesh-history-1",
        elements: "120",
        mesh: "mesh-2",
        nodes: "80",
        reason: "shared-domain",
        target: "study_domain",
      },
      {
        id: "mesh-history-0",
        elements: "90",
        mesh: "mesh-1",
        nodes: "50",
        reason: "selected-object",
        target: "object_mesh",
      },
    ]);
    expect(model.viewportRows).toEqual([
      { label: "Published", value: "42" },
      { label: "Loaded", value: "42" },
      { label: "Rendered", value: "42 via viewport-3d" },
    ]);
  });

  it("marks viewport delivery as not visible before a rendered acknowledgement", () => {
    const model = buildMeshJobsModel({
      activeBuild: {
        published_resources: {
          mesh_revision: 42,
        },
      },
      loadedMeshRevision: null,
      viewportConfirmation: null,
    });

    expect(model.viewportRows).toEqual([
      { label: "Published", value: "42" },
      { label: "Loaded", value: "waiting" },
      { label: "Rendered", value: "not visible" },
    ]);
  });
});
