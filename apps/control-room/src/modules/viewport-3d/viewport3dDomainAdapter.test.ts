import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";

import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
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
    generation_id: 4,
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
  };
}

describe("viewport3dDomainAdapter", () => {
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

  it("keeps helper boundary and interface parts out of renderable FEM part lists", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(domain.partsById.get("part-outer-boundary")?.role).toBe(
      "outer_boundary",
    );
    expect(domain.partsById.get("part-interface")?.role).toBe("interface");
    expect(domain.airboxParts.map((part) => part.id)).not.toContain(
      "part-outer-boundary",
    );
    expect(domain.magneticParts.map((part) => part.id)).not.toEqual(
      expect.arrayContaining(["part-outer-boundary", "part-interface"]),
    );
  });

  it("resolves FEM picking selection from mesh-part boundary faces", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(resolveFemPartSelectionByBoundaryFace(domain, 30)).toMatchObject({
      kind: "mesh-part-airbox",
      label: "Airbox",
      nodeId: "part-air",
      objectId: null,
    });
    expect(resolveFemPartSelectionByBoundaryFace(domain, 3)).toMatchObject({
      kind: "mesh-part",
      label: "Magnet",
      nodeId: "part-magnet",
      objectId: "object-1",
    });
    expect(resolveFemPartSelectionByBoundaryFace(domain, 999)).toBeNull();
  });

  it("resolves airbox mesh parts to the canonical airbox selection kind", () => {
    const domain = adaptFemSharedDomainManifest(manifestFixture());

    expect(selectionForMeshPart(domain.airboxParts[0])).toMatchObject({
      kind: "mesh-part-airbox",
      label: "Airbox",
      nodeId: "part-air",
      objectId: null,
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
