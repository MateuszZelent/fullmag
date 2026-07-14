import { describe, expect, it } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import {
  DATA_MESH_REGION_MEMBERSHIP_PATH,
  DATA_MESH_REGION_MEMBERSHIPS_PATH,
  DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
  DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH,
  DATA_FDM_REGION_MEMBERSHIPS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_HISTOGRAM_BIN_ELEMENTS_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_REGION_QUALITY_PATH,
  MESHING_UNIVERSE_POLICY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_SCENE_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import { ResourceInvalidationController } from "./ResourceInvalidationController";
import { ResourceRuntimeStore } from "./ResourceRuntimeStore";

import {
  GEOMETRY_DIAGNOSTICS_RESOURCE_KEY,
  GEOMETRY_CAPABILITIES_RESOURCE_KEY,
  GEOMETRY_VALIDATION_RESOURCE_KEY,
  FDM_REGION_MEMBERSHIPS_RESOURCE_KEY,
  FDM_REGION_MEMBERSHIP_BINARY_RESOURCE_KEY,
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  MESH_REGION_MEMBERSHIPS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  MODEL_REALIZED_REGIONS_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  VISUALIZATION_STATE_RESOURCE_KEY,
  resolveJsonResourceRevision,
  resolveFdmRegionMembershipBinaryResourceKey,
  resolveFdmRegionMembershipRevision,
  resolveMeshHistogramBinElementsResourceKey,
  resolveMeshRegionMembershipsRevision,
  resolveMeshRegionMembershipsResourceKey,
  resolveMeshRegionMembershipListRevision,
  resolveMeshRegionQualityResourceKey,
  resolveMeshSharedDomainManifestRevision,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshPolicyResourceKey,
  resolveObjectMeshReportResourceKey,
  resolveObjectInteractionResourceKey,
  resolveObjectTopologyResourceKey,
  resolveSceneResourceRevision,
  resolveVisualizationStateRevision,
  publishCommittedSceneResource,
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
    expect(MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY).toBe(
      MODEL_REGION_DIAGNOSTICS_PATH,
    );
    expect(MODEL_REALIZED_REGIONS_RESOURCE_KEY).toBe(
      MODEL_REALIZED_REGIONS_PATH,
    );
    expect(MESH_BUILD_CURRENT_RESOURCE_KEY).toBe(MESHING_BUILDS_CURRENT_PATH);
    expect(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY).toBe(
      MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
    );
    expect(MESH_UNIVERSE_POLICY_RESOURCE_KEY).toBe(
      MESHING_UNIVERSE_POLICY_PATH,
    );
    expect(MESH_REGION_MEMBERSHIPS_RESOURCE_KEY).toBe(
      DATA_MESH_REGION_MEMBERSHIPS_PATH,
    );
    expect(FDM_REGION_MEMBERSHIPS_RESOURCE_KEY).toBe(
      DATA_FDM_REGION_MEMBERSHIPS_PATH,
    );
    expect(FDM_REGION_MEMBERSHIP_BINARY_RESOURCE_KEY).toBe(
      DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
    );
    expect(resolveFdmRegionMembershipBinaryResourceKey("film:core")).toBe(
      `${DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH}:film%3Acore`,
    );
    expect(resolveFdmRegionMembershipBinaryResourceKey("film:core", "r7")).toBe(
      `${DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH}:film%3Acore#revision=r7`,
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
    expect(resolveMeshRegionQualityResourceKey("film:core")).toBe(
      MESHING_REGION_QUALITY_PATH.replace("{region_id}", "film%3Acore"),
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

  it("keeps FDM membership revisions tied to grid and legend identity", () => {
    expect(
      resolveFdmRegionMembershipRevision({
        binary_path: "mesh/fdm_region_membership.v1.bin",
        cell_count: 8,
        cell_m: [1, 1, 1],
        counts: [2, 2, 2],
        encoding: "u32le",
        freshness: "current",
        grid_fingerprint: "grid-1",
        mesh_revision: 7,
        origin_m: [0, 0, 0],
        region_legend: [],
        region_legend_fingerprint: "legend-1",
        region_membership_revision: 9,
        schema_version: "fdm_region_membership.v1",
      }),
    ).toBe("fdm_region_membership.v1:7:9:grid-1:legend-1");
  });

  it("uses a deterministic batch resource key and revision for mesh region memberships", () => {
    expect(
      resolveMeshRegionMembershipsResourceKey(["film:edge", "film:core", "film:core"]),
    ).toBe(
      `${DATA_MESH_REGION_MEMBERSHIP_PATH}:batch:film%3Acore|film%3Aedge`,
    );
    expect(resolveMeshRegionMembershipsResourceKey([])).toBe(
      `${DATA_MESH_REGION_MEMBERSHIP_PATH}:batch:none`,
    );

    expect(
      resolveMeshRegionMembershipsRevision([
        {
          mesh_id: "mesh:shared-domain",
          mesh_revision: 42,
          region_id: "film:edge",
          source: "geometry_projection",
        },
        {
          mesh_id: "mesh:shared-domain",
          mesh_revision: 41,
          region_id: "film:core",
          source: "geometry_projection",
        },
      ] as never),
    ).toBe(
      "mesh:shared-domain:41:film:core:geometry_projection|mesh:shared-domain:42:film:edge:geometry_projection",
    );
    expect(
      resolveMeshRegionMembershipListRevision({
        memberships: [
          {
            mesh_id: "mesh:shared-domain",
            mesh_revision: 41,
            region_id: "film:core",
            source: "geometry_projection",
          },
        ],
        mesh_id: "mesh:shared-domain",
        mesh_revision: 41,
        unresolved_region_ids: ["film:csg"],
      } as never),
    ).toBe(
      "mesh:shared-domain:41:mesh:shared-domain:41:film:core:geometry_projection:film:csg",
    );
  });

  it("seeds committed SceneDocument data even when the scene revision is unchanged", () => {
    const resources = new ResourceInvalidationController(
      new EventBus<KernelEventMap>(),
    );
    const runtimeStore = new ResourceRuntimeStore();

    resources.invalidate(MODEL_SCENE_PATH, 4);
    runtimeStore.updateData(MODEL_SCENE_PATH, { objects: [], revision: 4 }, 4);

    publishCommittedSceneResource(
      resources,
      {
        objects: [{ id: "box-1", name: "Box 1" }],
        revision: 4,
      },
      4,
      runtimeStore,
    );

    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(4);
    expect(runtimeStore.getSnapshot(MODEL_SCENE_PATH)).toMatchObject({
      data: {
        objects: [{ id: "box-1", name: "Box 1" }],
        revision: 4,
      },
      revision: 4,
      status: "ready",
    });
  });
});
