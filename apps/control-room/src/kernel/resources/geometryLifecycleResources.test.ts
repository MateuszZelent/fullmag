import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { DomainMetaResource } from "../api/apiTypes";
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
  MODEL_MAGNETIZATION_ASSET_PATH,
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
  resolveRegionCoefficientsRevision,
  resolveRegionRealizationRevision,
  resolveFdmRegionMembershipBinaryResourceKey,
  resolveFdmRegionMembershipDescriptorResult,
  resolveFdmRegionMembershipBinaryResult,
  resolveFdmRegionMembershipRevision,
  shouldLoadSingleGridFdmResources,
  resolveDomainPresentationRevision,
  resolveMeshHistogramBinElementsResourceKey,
  meshRegionMembershipResourceKey,
  resolveMeshRegionMembershipRevision,
  resolveMeshRegionMembershipsRevision,
  resolveMeshRegionMembershipsResourceKey,
  resolveMeshRegionMembershipListRevision,
  resolveMeshRegionQualityResourceKey,
  resolveMeshSharedDomainManifestRevision,
  resolveMagnetizationAssetResourceKey,
  resolveMagnetizationAssetResourceRevision,
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
  it("does not request single-grid FDM membership while multilayer layout is active or unresolved", () => {
    expect(
      shouldLoadSingleGridFdmResources(true, "loading", null),
    ).toBe(false);
    expect(
      shouldLoadSingleGridFdmResources(true, "ready", {
        available: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadSingleGridFdmResources(true, "ready", {
        available: false,
      }),
    ).toBe(true);
    expect(
      shouldLoadSingleGridFdmResources(true, "error", null),
    ).toBe(true);
    expect(
      shouldLoadSingleGridFdmResources(false, "ready", {
        available: false,
      }),
    ).toBe(false);
  });

  it("allows object FEM resources to be disabled for the explicit FDM lane", () => {
    const source = readFileSync(
      new URL("./geometryLifecycleResources.ts", import.meta.url),
      "utf8",
    );
    for (const hookName of [
      "useObjectTopologyResource",
      "useObjectMeshReportResource",
      "useObjectMeshQualityResource",
      "useObjectMeshSizeFieldResource",
      "useObjectMeshPolicyResource",
    ]) {
      const hookStart = source.indexOf(`export function ${hookName}`);
      expect(hookStart, hookName).toBeGreaterThanOrEqual(0);
      const hookSource = source.slice(hookStart, source.indexOf("\n}\n", hookStart) + 3);
      expect(hookSource, hookName).toContain("options: ResourceHookOptions = {}");
      expect(hookSource, hookName).toContain("options.enabled !== false");
      expect(hookSource, hookName).toContain("enabled,");
    }
  });

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
    expect(resolveMagnetizationAssetResourceKey("mag:free layer")).toBe(
      MODEL_MAGNETIZATION_ASSET_PATH.replace(
        "{asset_id}",
        "mag%3Afree%20layer",
      ),
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
    expect(
      resolveFdmRegionMembershipBinaryResourceKey("film:core", "r7", "film"),
    ).toBe(
      `${DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH}:owner:film:region:film%3Acore#revision=r7`,
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

  it("keys region-owned resources by independent realization revisions", () => {
    expect(
      resolveRegionRealizationRevision({
        region_topology_revision: 4,
        region_membership_revision: 5,
        region_coefficients_revision: 6,
        region_initial_state_revision: 7,
      }),
    ).toBe("4:5:6:7");
    expect(
      resolveRegionCoefficientsRevision({ region_coefficients_revision: 6 }),
    ).toBe(6);
    expect(
      resolveRegionCoefficientsRevision({ region_coefficients_revision: 7 }),
    ).not.toBe(6);
    expect(resolveRegionCoefficientsRevision({ revision: 99 } as never)).toBeNull();
  });

  it("keys magnetization assets by the initial-state realization lane", () => {
    expect(
      resolveMagnetizationAssetResourceRevision({
        scene_revision: 9,
        region_initial_state_revision: 12,
        asset: { id: "mag:free" },
      } as never),
    ).toBe("9:12");
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
        domain_generation_id: "generation-1",
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
    ).toBe("fdm_region_membership.v1:generation-1:7:9:grid-1:legend-1");
  });

  it("preserves the descriptor 204 response as an explicit pending contract state", () => {
    const result = resolveFdmRegionMembershipDescriptorResult({
      data: { data: null, status: "pending" },
      error: null,
      refetch: () => undefined,
      revision: 11,
      status: "ready",
    });

    expect(result).toMatchObject({
      availability: { reason: "not-materialized", status: "pending" },
      data: null,
      revision: 11,
      status: "ready",
    });
  });

  it("does not expose a previous descriptor while its invalidated revision is loading", () => {
    const current = {
      binary_path: "mesh/fdm.v2.bin",
      cell_count: 1,
      cell_m: [1, 1, 1],
      counts: [1, 1, 1],
      encoding: "FMRM:u32_membership_le",
      freshness: "current",
      grid_fingerprint: "grid-old",
      mesh_revision: 1,
      origin_m: [0, 0, 0],
      region_legend: [],
      region_membership_revision: 1,
      schema_version: "fdm_region_membership.v2",
    } as never;

    expect(
      resolveFdmRegionMembershipDescriptorResult({
        data: { data: current, status: "ready" },
        error: null,
        refetch: () => undefined,
        revision: 2,
        status: "loading",
      }),
    ).toMatchObject({
      availability: { reason: "loading", status: "pending" },
      data: null,
    });
  });

  it("keeps a decoded identity mismatch fail-closed as an explicit incompatible state", () => {
    const result = resolveFdmRegionMembershipBinaryResult(
      {
        data: { reason: "legend-count-mismatch", status: "incompatible" },
        error: null,
        refetch: () => undefined,
        revision: "membership-9",
        status: "ready",
      },
      {
        generationId: "generation-9",
        gridFingerprint: "grid-9",
        legendFingerprint: "legend-9",
        status: "ready",
      },
    );

    expect(result).toMatchObject({
      availability: { reason: "legend-count-mismatch", status: "incompatible" },
      data: null,
      revision: "membership-9",
      status: "ready",
    });
  });

  it("anchors domain presentation revisions to the realized FDM resource", () => {
    const domain: DomainMetaResource = {
      bounds: { min: [0, 0, 0], max: [2, 2, 1] },
      coordinate_system: "cartesian",
      counts: { cells: 4 },
      dimension: 3,
      discretization: "fdm",
      domain_id: "domain:fdm",
      generation_id: "generation-4",
      grid: { origin: [0, 0, 0], shape: [2, 2, 1], spacing: [1, 1, 1] },
      units: { length: "m" },
    };
    const membership = {
      binary_path: "mesh/fdm.v2.bin",
      cell_count: 4,
      cell_m: [1, 1, 1],
      counts: [2, 2, 1],
      domain_generation_id: "generation-4",
      encoding: "u32le",
      freshness: "current",
      grid_fingerprint: "grid-4",
      mesh_revision: 7,
      origin_m: [0, 0, 0],
      region_legend: [],
      region_membership_revision: 9,
      schema_version: "fdm_region_membership.v2",
    } as never;

    expect(resolveDomainPresentationRevision(domain)).toBe("generation-4");
    expect(resolveDomainPresentationRevision(domain, { fdmMembership: membership })).toBe(
      "generation-4:fdm_region_membership.v2:generation-4:7:9:grid-4:unknown",
    );
    expect(
      resolveDomainPresentationRevision(
        { ...domain, discretization: "fem", generation_id: "generation-5" },
        {
          femManifest: {
            revision: 4,
            source_scene_revision: 12,
            geometry_realization_revision: 11,
          } as never,
        },
      ),
    ).toBe("generation-5:4:12:11");
  });

  it("uses a deterministic batch resource key and revision for mesh region memberships", () => {
    expect(meshRegionMembershipResourceKey("film", "film:core")).toBe(
      `${DATA_MESH_REGION_MEMBERSHIP_PATH}:owner:film:region:film%3Acore`,
    );
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
          owner_object_id: "film",
          region_membership_revision: 8,
          region_id: "film:edge",
          source: "geometry_projection",
        },
        {
          mesh_id: "mesh:shared-domain",
          mesh_revision: 41,
          owner_object_id: "film",
          region_membership_revision: 7,
          region_id: "film:core",
          source: "geometry_projection",
        },
      ] as never),
    ).toBe(
      "mesh:shared-domain:41:7:film:film:core:geometry_projection|mesh:shared-domain:42:8:film:film:edge:geometry_projection",
    );
    expect(
      resolveMeshRegionMembershipListRevision({
        memberships: [
          {
            mesh_id: "mesh:shared-domain",
            mesh_revision: 41,
            owner_object_id: "film",
            region_membership_revision: 7,
            region_id: "film:core",
            source: "geometry_projection",
          },
        ],
        mesh_id: "mesh:shared-domain",
        mesh_revision: 41,
        unresolved_regions: [
          { owner_object_id: "film", region_id: "film:csg" },
        ],
      } as never),
    ).toBe(
      "mesh:shared-domain:41:mesh:shared-domain:41:7:film:film:core:geometry_projection:film\u0000film:csg",
    );

    expect(resolveMeshRegionMembershipRevision({
      mesh_id: "mesh:shared-domain",
      mesh_revision: 41,
      owner_object_id: "film-b",
      region_membership_revision: 7,
      region_id: "shared",
      source: "fem_shared_domain",
    } as never)).toBe(
      "mesh:shared-domain:41:7:film-b:shared:fem_shared_domain",
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
