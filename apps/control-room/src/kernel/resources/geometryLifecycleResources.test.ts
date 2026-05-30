import { describe, expect, it } from "vitest";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_HISTOGRAM_BIN_ELEMENTS_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_UNIVERSE_POLICY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";

import {
  GEOMETRY_DIAGNOSTICS_RESOURCE_KEY,
  GEOMETRY_CAPABILITIES_RESOURCE_KEY,
  GEOMETRY_VALIDATION_RESOURCE_KEY,
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  VISUALIZATION_STATE_RESOURCE_KEY,
  resolveJsonResourceRevision,
  resolveMeshHistogramBinElementsResourceKey,
  resolveMeshSharedDomainManifestRevision,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshPolicyResourceKey,
  resolveObjectMeshReportResourceKey,
  resolveObjectInteractionResourceKey,
  resolveObjectTopologyResourceKey,
  resolveSceneResourceRevision,
  resolveVisualizationStateRevision,
} from "./geometryLifecycleResources";

describe("geometry lifecycle resources", () => {
  it("uses canonical v2 resource paths as hook keys", () => {
    expect(SCENE_RESOURCE_KEY).toBe(MODEL_SCENE_PATH);
    expect(GEOMETRY_CAPABILITIES_RESOURCE_KEY).toBe(
      MODEL_GEOMETRY_CAPABILITIES_PATH,
    );
    expect(GEOMETRY_VALIDATION_RESOURCE_KEY).toBe(
      MODEL_GEOMETRY_VALIDATION_PATH,
    );
    expect(GEOMETRY_DIAGNOSTICS_RESOURCE_KEY).toBe(
      MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    );
    expect(MESH_BUILD_CURRENT_RESOURCE_KEY).toBe(MESHING_BUILDS_CURRENT_PATH);
    expect(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY).toBe(
      MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
    );
    expect(MESH_UNIVERSE_POLICY_RESOURCE_KEY).toBe(
      MESHING_UNIVERSE_POLICY_PATH,
    );
    expect(VISUALIZATION_STATE_RESOURCE_KEY).toBe(VISUALIZATION_STATE_PATH);
    expect(resolveObjectTopologyResourceKey("box 1")).toBe(
      MESHING_OBJECT_TOPOLOGY_PATH.replace("{object_id}", "box%201"),
    );
    expect(resolveObjectMeshReportResourceKey("box 1")).toBe(
      MESHING_OBJECT_REPORT_PATH.replace("{object_id}", "box%201"),
    );
    expect(resolveObjectMeshQualityResourceKey("box 1")).toBe(
      MESHING_OBJECT_QUALITY_PATH.replace("{object_id}", "box%201"),
    );
    expect(resolveObjectMeshPolicyResourceKey("box 1")).toBe(
      MESHING_OBJECT_POLICY_PATH.replace("{object_id}", "box%201"),
    );
    expect(resolveObjectInteractionResourceKey("box 1", "interfacial_dmi")).toBe(
      MODEL_OBJECT_INTERACTION_PATH.replace("{object_id}", "box%201").replace(
        "{interaction_kind}",
        "interfacial_dmi",
      ),
    );
    expect(
      resolveMeshHistogramBinElementsResourceKey({
        binIndex: 12,
        meshId: "study domain",
        metric: "characteristic_size",
        partId: "airbox part",
      }),
    ).toBe(
      MESHING_HISTOGRAM_BIN_ELEMENTS_PATH.replace("{mesh_id}", "study%20domain")
        .replace("{part_id}", "airbox%20part")
        .replace("{metric}", "characteristic_size")
        .replace("{bin_index}", "12"),
    );
  });

  it("resolves scene and generic json revisions without schema-specific stores", () => {
    expect(resolveSceneResourceRevision({ revision: 9 })).toBe(9);
    expect(resolveSceneResourceRevision({ scene_revision: 11 })).toBe(11);
    expect(resolveSceneResourceRevision({ objects: [] })).toBeNull();
    expect(resolveJsonResourceRevision({ revision: "mesh-7" })).toBe("mesh-7");
    expect(resolveJsonResourceRevision(null)).toBeNull();
    expect(resolveVisualizationStateRevision({ revision: 15 } as never)).toBe(15);
  });

  it("includes mesh provenance in shared-domain manifest revision signatures", () => {
    expect(
      resolveMeshSharedDomainManifestRevision({
        revision: 4,
        source_scene_revision: 12,
        geometry_realization_revision: 11,
      } as never),
    ).toBe("4:12:11");
    expect(
      resolveMeshSharedDomainManifestRevision({
        revision: 4,
        source_scene_revision: null,
        geometry_realization_revision: null,
      } as never),
    ).toBe("4:unknown:unknown");
  });
});
