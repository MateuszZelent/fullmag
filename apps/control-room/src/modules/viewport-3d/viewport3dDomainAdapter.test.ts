import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs";

import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
  adaptDomainPresentation,
  adaptFdmDomainPresentation,
  resolveViewport3DFdmRealizedRegionIds,
  resolveFemPartSelectionByBoundaryFace,
  resolveMeshPartBounds,
  selectionForMeshPart,
} from "./viewport3dDomainAdapter";

function fdmMeta(cells: number): DomainMetaResource {
  return {
    bounds: {
      max: [10, 10, 1],
      min: [0, 0, 0],
    },
    coordinate_system: "cartesian",
    counts: { cells },
    dimension: 3,
    discretization: "fdm",
    domain_id: "domain",
    generation_id: "4",
    grid: {
      origin: [0, 0, 0],
      shape: [100, 100, 1],
      spacing: [0.1, 0.1, 1],
    },
    units: { length: "m" },
  };
}

function manifestFixture(): MeshSharedDomainManifestResource {
  return {
    mesh_id: "mesh-1",
    mesh_name: "shared",
    mesh_parts: [
      {
        boundary_face_count: 2,
        boundary_face_indices: [30, 31],
        boundary_face_start: 0,
        bounds_max: [2, 2, 2],
        bounds_min: [0, 0, 0],
        element_count: 8,
        element_start: 0,
        id: "part-air",
        label: "Airbox",
        node_count: 6,
        node_start: 0,
        role: "air",
      },
      {
        boundary_face_count: 4,
        boundary_face_start: 2,
        element_count: 12,
        element_start: 8,
        id: "part-magnet",
        label: "Magnet",
        node_count: 8,
        node_start: 6,
        object_id: "object-1",
        role: "magnetic",
      },
      {
        boundary_face_count: 0,
        boundary_face_indices: [30, 31],
        boundary_face_start: 0,
        element_count: 0,
        element_start: 0,
        id: "part-outer-boundary",
        label: "Outer Boundary",
        node_count: 0,
        node_start: 0,
        role: "outer_boundary",
      },
      {
        boundary_face_count: 0,
        boundary_face_start: 0,
        element_count: 0,
        element_start: 0,
        id: "part-interface",
        label: "Air ↔ Magnet",
        node_count: 0,
        node_start: 0,
        role: "interface",
        surface_faces: [[0, 1, 2]],
      },
    ],
    revision: 7,
    topology_fingerprint: "mesh-topology-hash",
  };
}

describe("viewport3dDomainAdapter", () => {
  const fdmMembership: FdmRegionMembershipResource = {
    binary_path: "membership.bin",
    cell_count: 10_000,
    cell_m: [0.1, 0.1, 1],
    counts: [100, 100, 1],
    domain_generation_id: "generation-current",
    encoding: "u32le",
    freshness: "current",
    grid_fingerprint: "grid-current",
    mesh_revision: 2,
    origin_m: [0, 0, 0],
    region_legend: [],
    region_membership_revision: 3,
    schema_version: "fdm_region_membership.v1",
  };
  const fdmMembershipBinary: DecodedFdmRegionMembership = {
    cellCount: 10_000,
    counts: [100, 100, 1],
    formatVersion: 2,
    gridFingerprint: "grid-current",
    legendCount: 0,
    payloadKind: 2,
    regionIds: new Uint32Array(10_000),
    semanticStatus: "canonical",
  };

  it("renders FDM membership only after the central presentation proves current matching identities", () => {
    const presentation = adaptDomainPresentation({
      domainMeta: fdmMeta(10_000),
      expectedFdmGridFingerprint: fdmMembershipBinary.gridFingerprint,
      fdmMembership,
      fdmMembershipStatus: "ready",
    });

    expect(
      resolveViewport3DFdmRealizedRegionIds(
        presentation,
        fdmMembershipBinary,
      ),
    ).toBe(fdmMembershipBinary.regionIds);
  });

  it("fails closed when DomainMeta cell count disagrees with the structured shape", () => {
    const presentation = adaptDomainPresentation({
      domainMeta: fdmMeta(9_999),
      fdmMembership: null,
      fdmMembershipStatus: "ready",
    });

    expect(presentation.resourceStatus).toBe("incompatible");
    expect(adaptFdmDomainPresentation(presentation, 1_000)).toBeNull();
  });

  it("fails closed instead of throwing when a malformed presentation omits bounds", () => {
    expect(
      adaptFdmDomainPresentation(
        {
          discretization: "fdm",
          fdmGrid: {
            descriptorCellCountCompatible: true,
            origin: [0, 0, 0],
            shape: [1, 1, 1],
            spacing: [1, 1, 1],
            totalCells: 1,
          },
        } as never,
        1_000,
      ),
    ).toBeNull();
  });

  it.each([
    ["stale descriptor", { ...fdmMembership, freshness: "stale" }, fdmMembershipBinary],
    [
      "descriptor and binary fingerprint mismatch",
      fdmMembership,
      { ...fdmMembershipBinary, gridFingerprint: "grid-stale" },
    ],
    [
      "binary geometry mismatch",
      fdmMembership,
      { ...fdmMembershipBinary, counts: [50, 200, 1] as [number, number, number] },
    ],
  ] as const)("fails closed for %s", (_label, descriptor, binary) => {
    const presentation = adaptDomainPresentation({
      domainMeta: fdmMeta(10_000),
      expectedFdmGridFingerprint: binary.gridFingerprint,
      fdmMembership: descriptor,
      fdmMembershipStatus: "ready",
    });

    expect(
      resolveViewport3DFdmRealizedRegionIds(presentation, binary),
    ).toBeNull();
  });

  it("applies an FDM display budget before any cell buffer allocation", () => {
    const domain = adaptFdmDomainMeta(fdmMeta(10_000), 1_000);

    expect(domain).toMatchObject({
      displayCellBudget: 1000,
      displayCellCount: 1000,
      kind: "fdm-grid",
      origin: [0, 0, 0],
      shape: [100, 100, 1],
      spacing: [0.1, 0.1, 1],
      stride: 10,
      totalCells: 10000,
    });
  });

  it("separates airbox parts from magnetic FEM parts using mesh part roles", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(domain.airboxParts.map((part) => part.id)).toEqual(["part-air"]);
    expect(domain.magneticParts.map((part) => part.id)).toEqual(["part-magnet"]);
    expect(domain.objectPartIds.get("object-1")).toEqual(["part-magnet"]);
    expect(domain.partsById.get("part-air")?.role).toBe("air");
  });

  it("indexes mesh parts by object and geometry aliases", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts = [
      {
        boundary_face_count: 4,
        boundary_face_start: 0,
        element_count: 12,
        element_start: 0,
        geometry_id: "object-1_geom",
        id: "part-magnet",
        label: "Magnet",
        node_count: 8,
        node_start: 0,
        object_id: "object-1",
        role: "magnetic",
      },
    ];

    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.objectPartIds.get("object-1")).toEqual(["part-magnet"]);
    expect(domain.objectPartIds.get("object-1_geom")).toEqual(["part-magnet"]);
  });

  it("normalizes segment-only manifests into degraded render carriers", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts = [];
    manifest.object_segments = [
      {
        boundary_face_count: 4,
        boundary_face_start: 2,
        element_count: 12,
        element_start: 8,
        geometry_id: "object-1_geom",
        node_count: 8,
        node_start: 6,
        object_id: "object-1",
      },
    ];

    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.magneticParts).toMatchObject([
      {
        carrierKind: "object-segment",
        fieldCapable: false,
        id: "segment:object-1:fa636585",
        object_id: "object-1",
        role: "magnetic",
      },
    ]);
    expect(domain.objectPartIds.get("object-1")).toEqual([
      "segment:object-1:fa636585",
    ]);
    expect(domain.partsById.get("segment:object-1:fa636585")).toMatchObject({
      carrierKind: "object-segment",
      fieldCapable: false,
    });
  });

  it("prefers mesh parts over duplicate object-segment fallback carriers", () => {
    const manifest = manifestFixture();
    manifest.object_segments = [
      {
        boundary_face_count: 4,
        boundary_face_start: 2,
        element_count: 12,
        element_start: 8,
        geometry_id: "object-1_geom",
        node_count: 8,
        node_start: 6,
        object_id: "object-1",
      },
    ];

    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.magneticParts.map((part) => part.id)).toEqual(["part-magnet"]);
    expect(domain.objectPartIds.get("object-1")).toEqual(["part-magnet"]);
    expect(domain.renderCarrierDiagnostics).toEqual({
      degradedCarrierCount: 0,
      kind: "mesh-parts",
      rejectedCarrierCount: 0,
      renderableCarrierCount: 2,
    });
  });

  it("collapses the production Airbox mesh part and segment into one carrier", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts = [
      {
        ...manifest.mesh_parts![0]!,
        geometry_id: null,
        id: "part:__air__",
        object_id: null,
        role: "air",
      },
    ];
    manifest.object_segments = [
      {
        boundary_face_count: 60,
        boundary_face_start: 0,
        element_count: 175,
        element_start: 0,
        geometry_id: null,
        node_count: 32,
        node_start: 0,
        object_id: "__air__",
      },
    ];

    const domain = adaptFemSharedDomainManifest(manifest);

    expect([...domain.partsById.keys()]).toEqual(["part:__air__"]);
    expect(domain.airboxParts).toMatchObject([
      {
        carrierKind: "mesh-part",
        fieldCapable: true,
        id: "part:__air__",
        role: "air",
      },
    ]);
    expect(domain.magneticParts).toEqual([]);
    expect(domain.objectPartIds.has("__air__")).toBe(false);
    expect(domain.renderCarrierDiagnostics).toEqual({
      degradedCarrierCount: 0,
      kind: "mesh-parts",
      rejectedCarrierCount: 0,
      renderableCarrierCount: 1,
    });
  });

  it("keeps a segment-only Airbox as a degraded Airbox without object ownership", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts = [];
    manifest.object_segments = [
      {
        boundary_face_count: 60,
        boundary_face_start: 0,
        element_count: 175,
        element_start: 0,
        geometry_id: null,
        node_count: 32,
        node_start: 0,
        object_id: "__air__",
      },
    ];

    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.airboxParts).toMatchObject([
      {
        carrierKind: "object-segment",
        fieldCapable: false,
        label: "Airbox",
        object_id: "__air__",
        role: "air",
      },
    ]);
    expect(domain.magneticParts).toEqual([]);
    expect(domain.objectPartIds.has("__air__")).toBe(false);
    expect(selectionForMeshPart(domain.airboxParts[0]!)).toMatchObject({
      kind: "mesh-part-airbox",
      label: "Airbox",
      objectId: null,
    });
  });

  it("keeps helper boundary parts out of renderable FEM part lists", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(domain.partsById.get("part-outer-boundary")?.role).toBe(
      "outer_boundary",
    );
    expect(domain.airboxParts.map((part) => part.id)).not.toContain(
      "part-outer-boundary",
    );
    expect(domain.magneticParts.map((part) => part.id)).not.toContain(
      "part-outer-boundary",
    );
  });

  it("assigns air-magnetic interface surfaces to the owning magnetic part", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts![3]!.object_id = "object-1";
    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.partsById.get("part-interface")?.role).toBe("interface");
    expect(domain.magneticParts.map((part) => part.id)).toEqual(["part-magnet"]);
    expect(domain.magneticSurfacePartsByPartId.get("part-magnet")?.map((part) => part.id))
      .toEqual(["part-interface"]);
  });

  it("resolves FEM picking selection from mesh-part boundary faces", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(resolveFemPartSelectionByBoundaryFace(domain, 30)).toMatchObject({
      carrierPartId: "part-air",
      kind: "mesh-part-airbox",
      label: "Airbox",
      objectId: null,
    });
    expect(resolveFemPartSelectionByBoundaryFace(domain, 3)).toMatchObject({
      carrierPartId: "part-magnet",
      kind: "mesh-part",
      label: "Magnet",
      objectId: "object-1",
    });
    expect(resolveFemPartSelectionByBoundaryFace(domain, 999)).toBeNull();
  });

  it("resolves airbox mesh parts to the canonical airbox selection kind", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(selectionForMeshPart(domain.airboxParts[0])).toMatchObject({
      carrierPartId: "part-air",
      kind: "mesh-part-airbox",
      label: "Airbox",
      objectId: null,
    });
  });

  it("treats the legacy airbox role as the canonical Airbox carrier", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts![0]!.role = "airbox";
    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.airboxParts.map((part) => part.id)).toContain("part-air");
    expect(selectionForMeshPart(domain.airboxParts[0])).toMatchObject({
      carrierPartId: "part-air",
      kind: "mesh-part-airbox",
    });
  });

  it("keeps part:__air__ on the Airbox path when its role is degraded", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts![0]!.id = "part:__air__";
    manifest.mesh_parts![0]!.role = "carrier";
    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.airboxParts.map((part) => part.id)).toEqual(["part:__air__"]);
    expect(domain.magneticParts.map((part) => part.id)).not.toContain("part:__air__");
    expect(selectionForMeshPart(domain.airboxParts[0])).toMatchObject({
      carrierPartId: "part:__air__",
      kind: "mesh-part-airbox",
      objectId: null,
    });
  });

  it("rejects blank and duplicate carrier identities before render or picking", () => {
    const manifest = manifestFixture();
    manifest.mesh_parts!.push({ ...manifest.mesh_parts![1]! });
    manifest.mesh_parts!.push({
      ...manifest.mesh_parts![1]!,
      id: "",
      label: "Missing identity",
    });
    const domain = adaptFemSharedDomainManifest(manifest);

    expect(domain.magneticParts.filter((part) => part.id === "part-magnet")).toHaveLength(1);
    expect(domain.partsById.has("")).toBe(false);
    expect(domain.renderCarrierDiagnostics?.rejectedCarrierCount).toBe(2);
  });

  it("preserves geometry-only object ownership in mesh part selections", () => {
    expect(
      selectionForMeshPart({
        geometry_id: "free-layer_geom",
        id: "part:free-layer",
        label: "Free layer",
        object_id: null,
        role: "magnetic",
      } as Parameters<typeof selectionForMeshPart>[0]),
    ).toMatchObject({
      carrierPartId: "part:free-layer",
      kind: "mesh-part",
      objectId: "free-layer",
    });
  });

  it("resolves mesh-part bounds for airbox and selection layers", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(resolveMeshPartBounds(domain.partsById.get("part-air"))).toMatchObject({
      center: [1, 1, 1],
      size: [2, 2, 2],
    });
  });
});
