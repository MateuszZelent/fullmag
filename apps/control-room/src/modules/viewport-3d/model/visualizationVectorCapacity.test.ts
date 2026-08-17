import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import { resolveVisualizationVectorCapacityForTarget } from "@/modules/inspector/panels/ObjectVisualizationPanelModel";

import {
  fdmMultilayerAirboxVisualizationVectorCapacitySource,
  fdmVisualizationVectorCapacitySource,
  resolveVisualizationVectorCapacityDescriptor,
  visualizationVectorBudgetRangeFromCapacity,
  type VisualizationVectorCapacitySource,
} from "./visualizationVectorCapacity";

const target = (id: string, kind: "airbox" | "fdm-domain" = "fdm-domain") => ({
  id,
  kind,
});

describe("visualization vector capacity", () => {
  it("adapts DomainMeta and FMRM support counts for a single-grid Airbox", () => {
    const domain = {
      bounds: { max: [199_680, 1, 1], min: [0, 0, 0] },
      coordinate_system: "cartesian",
      counts: { cells: 199_680 },
      dimension: 3,
      discretization: "FDM",
      domain_id: "domain-7",
      generation_id: "generation-7",
      grid: {
        origin: [0, 0, 0],
        shape: [199_680, 1, 1],
        spacing: [1, 1, 1],
      },
      units: {},
    } as DomainMetaResource;
    const membership = {
      binary_path: "fields/membership.fmrm",
      cell_count: 199_680,
      cell_m: [1, 1, 1],
      counts: [1_600, 198_080],
      domain_generation_id: "generation-7",
      encoding: "u32",
      freshness: "current",
      grid_fingerprint: "grid-7",
      magnetic_support: {
        active_cell_count: 1_600,
        active_unassigned_cell_count: 1_600,
        bounds_max_m: [1, 1, 1],
        bounds_min_m: [0, 0, 0],
        grid_fingerprint: "grid-7",
        inactive_cell_count: 198_080,
        semantic_role: "magnetic-support",
      },
      mesh_revision: 3,
      origin_m: [0, 0, 0],
      region_legend: [],
      region_membership_revision: 4,
      schema_version: "FMRM v1",
    } as FdmRegionMembershipResource;

    const source = fdmVisualizationVectorCapacitySource({
      domain,
      membership,
    });

    expect(source).toMatchObject({
      activeCellCount: 1_600,
      carrierId: "fdm:grid-7",
      inactiveCellCount: 198_080,
      revision: "3:4",
      shape: [199_680, 1, 1],
    });
    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source: source!,
        target: { id: "airbox", kind: "airbox" },
      }),
    ).toMatchObject({
      anchorKind: "cell",
      fullCount: 198_080,
      targetId: "airbox",
    });
  });

  it("preserves multilayer carrier identity and distinguishes Full from Surface", () => {
    const source = fdmMultilayerAirboxVisualizationVectorCapacitySource({
      carrierFingerprint: "native-grid-hash",
      carrierId: "fdm-multilayer:airbox:generation-9",
      cellCount: 125,
      domainGenerationId: "generation-9",
      revision: "carrier-revision-12",
      shape: [5, 5, 5],
    });

    const full = resolveVisualizationVectorCapacityDescriptor({
      geometryScope: "full",
      source: source!,
      target: { id: "airbox", kind: "airbox" },
    });
    const surface = resolveVisualizationVectorCapacityDescriptor({
      geometryScope: "surface",
      source: source!,
      target: { id: "airbox", kind: "airbox" },
    });

    expect(full).toMatchObject({
      carrierId: "fdm-multilayer:airbox:generation-9",
      fullCount: 125,
      generation: "generation-9",
      revision: "carrier-revision-12",
      surfaceCount: 98,
    });
    expect(surface).toMatchObject({
      exact: true,
      fullCount: 125,
      surfaceCount: 98,
    });
    expect(surface?.surfaceCount).toBeLessThan(full?.fullCount ?? 0);
  });

  it("resolves FEM object, region, part and Airbox capacities from manifest carriers", () => {
    const manifest = {
      generation_id: "fem-generation-4",
      mesh_id: "shared-domain",
      mesh_name: "Shared domain",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          geometry_id: "film-geometry",
          id: "part:film:object",
          label: "Film",
          node_count: 4,
          node_indices: [0, 1, 2, 3],
          node_start: 0,
          object_id: "film",
          role: "magnetic_object",
          surface_node_indices: [0, 1, 2],
        },
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 1,
          id: "part:film:core",
          label: "Core",
          node_count: 3,
          node_indices: [3, 4, 5],
          node_start: 3,
          object_id: "film",
          role: "magnetic_object",
          surface_node_indices: [3, 4],
        },
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 2,
          id: "part:film:aux",
          label: "Auxiliary",
          node_count: 2,
          node_indices: [6, 7],
          node_start: 6,
          object_id: "film",
          role: "magnetic_object",
          surface_node_indices: [6],
        },
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 3,
          id: "part:__air__",
          label: "Airbox",
          node_count: 3,
          node_indices: [8, 9, 10],
          node_start: 8,
          role: "air",
          surface_node_indices: [8, 9],
        },
      ],
      regions: [
        {
          material_ref: "material:film",
          mesh_part_ids: ["part:film:core"],
          name: "Core",
          region_id: "manifest:film:core",
          source_object_ids: ["film"],
          source_region_candidate_id: "film:core",
        },
      ],
      revision: 4,
      topology_fingerprint: "fem-topology-4",
    } as MeshSharedDomainManifestResource;

    expect(
      resolveVisualizationVectorCapacityForTarget({
        femManifest: manifest,
        target: { id: "object:film", kind: "object" },
      }),
    ).toMatchObject({ fullCount: 8, targetId: "object:film" });
    for (const targetId of ["region:film:core", "region:film:film%3Acore"]) {
      expect(
        resolveVisualizationVectorCapacityForTarget({
          femManifest: manifest,
          target: { id: targetId, kind: "region" },
        }),
      ).toMatchObject({ fullCount: 3, targetId });
    }
    expect(
      resolveVisualizationVectorCapacityForTarget({
        femManifest: manifest,
        target: { id: "part:film:aux", kind: "part" },
      }),
    ).toMatchObject({ fullCount: 2, targetId: "part:film:aux" });
    expect(
      resolveVisualizationVectorCapacityForTarget({
        femManifest: manifest,
        target: { id: "airbox", kind: "airbox" },
      }),
    ).toMatchObject({ fullCount: 3, targetId: "airbox" });
  });

  it("reports geometry-specific exactness for a capacity range", () => {
    const descriptor = {
      anchorKind: "node" as const,
      carrierId: "mesh-unknown-surface",
      exact: true,
      fullExact: true,
      fullCount: 20,
      generation: "generation-4",
      revision: 4,
      surfaceExact: false,
      surfaceCount: 7,
      targetId: "object:film",
      topologyHash: "topology-4",
    };

    expect(
      visualizationVectorBudgetRangeFromCapacity(descriptor, "surface"),
    ).toMatchObject({
      availableNodeCount: 7,
      exact: false,
      max: 7,
    });
  });

  it("derives single-grid FDM Airbox capacity from inactive membership cells", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm",
      carrierId: "fdm:grid-7",
      domainGenerationId: "generation-7",
      gridFingerprint: "grid-7",
      shape: [199_680, 1, 1],
      activeCellCount: 1_600,
      inactiveCellCount: 198_080,
      realizedRegionIds: null,
      revision: "mesh-3:membership-4",
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: target("airbox", "airbox"),
        geometryScope: "full",
      }),
    ).toMatchObject({
      targetId: "airbox",
      carrierId: "fdm:grid-7",
      anchorKind: "cell",
      fullCount: 198_080,
      surfaceCount: 198_080,
      exact: true,
      generation: "generation-7",
      revision: "mesh-3:membership-4",
    });
  });

  it("uses the shared FDM cell-neighbour rule so Surface can differ from Full", () => {
    const shape: [number, number, number] = [5, 5, 5];
    const realizedRegionIds = new Uint32Array(125);
    realizedRegionIds.fill(FMRM_INACTIVE_REGION_ID);
    realizedRegionIds[62] = 1;
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm",
      carrierId: "fdm:grid-surface",
      domainGenerationId: "generation-surface",
      gridFingerprint: "grid-surface",
      shape,
      activeCellCount: 1,
      inactiveCellCount: 124,
      realizedRegionIds,
      revision: 8,
    };

    const descriptor = resolveVisualizationVectorCapacityDescriptor({
      source,
      target: target("airbox", "airbox"),
      geometryScope: "full",
    });
    const surface = resolveVisualizationVectorCapacityDescriptor({
      source,
      target: target("airbox", "airbox"),
      geometryScope: "surface",
    });

    expect(descriptor?.fullCount).toBe(124);
    expect(surface?.surfaceCount).toBeLessThan(descriptor?.fullCount ?? 0);
    expect(surface?.surfaceCount).toBeGreaterThan(0);
  });

  it("uses native layer counts and identity instead of the common-grid shape", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm-native-layer",
      carrierId: "fdm-native-layer:layer%3Atop",
      domainGenerationId: "generation-native",
      gridFingerprint: "native-grid-top",
      shape: [4, 4, 4],
      activeCellCount: 10,
      inactiveCellCount: 54,
      activeMask: Uint8Array.from({ length: 64 }, (_, index) => (index < 10 ? 1 : 0)),
      revision: 12,
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: source.carrierId, kind: "fdm-native-layer" },
        geometryScope: "full",
      }),
    ).toMatchObject({
      fullCount: 10,
      anchorKind: "cell",
      carrierId: source.carrierId,
      generation: "generation-native",
      revision: 12,
    });
  });

  it("uses the validated active count for a dense native layer when its mask is omitted", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm-native-layer",
      carrierId: "fdm-native-layer:layer%3Adense",
      domainGenerationId: "generation-native-dense",
      gridFingerprint: "native-grid-dense",
      shape: [4, 4, 4],
      activeCellCount: 64,
      inactiveCellCount: 0,
      activeMask: null,
      revision: 13,
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: source.carrierId, kind: "fdm-native-layer" },
        geometryScope: "full",
      }),
    ).toMatchObject({
      fullCount: 64,
      anchorKind: "cell",
      carrierId: source.carrierId,
      generation: "generation-native-dense",
      revision: 13,
    });
  });

  it("counts FEM anchors as a union of target mesh-part nodes", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fem",
      carrierId: "mesh-1",
      generation: "mesh-generation-1",
      revision: 4,
      topologyHash: "topology-1",
      fullNodeIndices: [1, 2, 3, 3, 4],
      surfaceNodeIndices: [1, 2, 4],
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: "object:film", kind: "object" },
        geometryScope: "full",
      }),
    ).toMatchObject({
      anchorKind: "node",
      fullCount: 4,
      surfaceCount: 3,
      exact: true,
      carrierId: "mesh-1",
      generation: "mesh-generation-1",
      revision: 4,
      topologyHash: "topology-1",
    });
  });

  it("fails closed when FEM node indices are not published", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fem",
      carrierId: "mesh-unknown",
      fullExact: false,
      fullNodeIndices: [0, 1, 2, 3],
      generation: "mesh-generation-unknown",
      revision: 5,
      surfaceExact: false,
      surfaceNodeIndices: [0, 1],
      topologyHash: null,
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: "object:film", kind: "object" },
      }),
    ).toMatchObject({
      exact: false,
      fullCount: 4,
      surfaceCount: 2,
    });
  });

  it("fails closed for a partial native layer without its active mask", () => {
    const source: VisualizationVectorCapacitySource = {
      activeCellCount: 10,
      activeMask: null,
      carrierId: "native:layer-top",
      domainGenerationId: "generation-native",
      gridFingerprint: "native-grid",
      inactiveCellCount: 54,
      kind: "fdm-native-layer",
      revision: 6,
      shape: [4, 4, 4],
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: "native:layer-top", kind: "fdm-native-layer" },
      }),
    ).toMatchObject({ exact: false, fullCount: 10 });
  });
});
