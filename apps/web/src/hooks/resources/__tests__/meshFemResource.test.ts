import { describe, expect, it } from "vitest";

import {
  applyMeshSharedDomainManifest,
  buildFemMeshFromDecodedTopology,
  mergeFemMeshResource,
} from "../meshFemResource";
import type { MeshSummaryState } from "@/lib/session/types";

function makeSummary(
  overrides: Partial<MeshSummaryState> = {},
): MeshSummaryState {
  return {
    mesh_id: "mesh-1",
    mesh_name: "shared-domain",
    mesh_source: "runtime",
    backend: "mfem",
    source_kind: "shared_domain",
    order: 1,
    hmax: 1,
    node_count: 4,
    element_count: 1,
    boundary_face_count: 4,
    bounds_min: [0, 0, 0],
    bounds_max: [1, 1, 1],
    mesh_extent: [1, 1, 1],
    world_extent: [1, 1, 1],
    world_center: [0.5, 0.5, 0.5],
    world_extent_source: "mesh",
    domain_frame: null,
    domain_mesh_mode: "shared_domain_mesh_with_air",
    generation_id: "gen-1",
    ...overrides,
  };
}

function makeDecodedTopology() {
  return {
    nodeCount: 4,
    elementCount: 1,
    boundaryFaceCount: 4,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 3]),
    boundaryFaces: new Uint32Array([
      0, 1, 2,
      0, 1, 3,
      0, 2, 3,
      1, 2, 3,
    ]),
    elementMarkers: new Uint32Array([7]),
    boundaryMarkers: new Uint32Array([1, 2, 3, 4]),
  };
}

describe("meshFemResource helpers", () => {
  it("builds FemLiveMesh from decoded topology and summary metadata", () => {
    const mesh = buildFemMeshFromDecodedTopology(
      makeDecodedTopology(),
      makeSummary(),
    );

    expect(mesh.generation_id).toBe("gen-1");
    expect(mesh.mesh_id).toBe("mesh-1");
    expect(mesh.domain_mesh_mode).toBe("shared_domain_mesh_with_air");
    expect(mesh.nodes).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(mesh.elements).toEqual([[0, 1, 2, 3]]);
    expect(mesh.topology_transport).toBe("binary");
    expect(mesh.node_count).toBe(4);
    expect(mesh.element_markers).toEqual([7]);
  });

  it("applies shared-domain manifest metadata needed by the FEM tree", () => {
    const mesh = applyMeshSharedDomainManifest(
      buildFemMeshFromDecodedTopology(
        makeDecodedTopology(),
        makeSummary(),
      ),
      {
        revision: 1,
        mesh_name: "shared-domain",
        mesh_id: "mesh-1",
        generation_id: "gen-1",
        domain_mesh_mode: "shared_domain_mesh_with_air",
        object_segments: [
          {
            object_id: "obj-1",
            geometry_id: "geom-1",
            node_start: 0,
            node_count: 4,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 4,
          },
        ],
        mesh_parts: [
          {
            id: "air",
            label: "Airbox",
            role: "air",
            object_id: null,
            geometry_id: null,
            material_id: null,
            element_start: 0,
            element_count: 0,
            boundary_face_start: 0,
            boundary_face_count: 0,
            boundary_face_indices: [],
            node_start: 0,
            node_count: 0,
            node_indices: [],
            surface_faces: [],
            bounds_min: [-1, -1, -1],
            bounds_max: [2, 2, 2],
          },
          {
            id: "obj-1",
            label: "Body",
            role: "magnetic_object",
            object_id: "obj-1",
            geometry_id: "geom-1",
            material_id: "mat-1",
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 4,
            boundary_face_indices: [0, 1, 2, 3],
            node_start: 0,
            node_count: 4,
            node_indices: [0, 1, 2, 3],
            surface_faces: [[0, 1, 2]],
            bounds_min: [0, 0, 0],
            bounds_max: [1, 1, 1],
          },
        ],
      },
    );

    expect(mesh.object_segments).toHaveLength(1);
    expect(mesh.object_segments?.[0]?.object_id).toBe("obj-1");
    expect(mesh.mesh_parts).toHaveLength(2);
    expect(mesh.mesh_parts?.[0]?.role).toBe("air");
    expect(mesh.mesh_parts?.[1]?.object_id).toBe("obj-1");
  });

  it("preserves richer metadata from the current mesh when identities match", () => {
    const resourceMesh = buildFemMeshFromDecodedTopology(
      makeDecodedTopology(),
      makeSummary(),
    );
    const merged = mergeFemMeshResource(resourceMesh, {
      ...resourceMesh,
      mesh_parts: [
        {
          id: "part-1",
          label: "part-1",
          role: "magnetic_object",
          object_id: "obj-1",
          geometry_id: "geom-1",
          material_id: "mat-1",
          element_start: 0,
          element_count: 1,
          boundary_face_start: 0,
          boundary_face_count: 4,
          boundary_face_indices: [0, 1, 2, 3],
          node_start: 0,
          node_count: 4,
          node_indices: [0, 1, 2, 3],
          surface_faces: [[0, 1, 2]],
          bounds_min: [0, 0, 0],
          bounds_max: [1, 1, 1],
        },
      ],
      object_segments: [
        {
          object_id: "obj-1",
          geometry_id: "geom-1",
          node_start: 0,
          node_count: 4,
          element_start: 0,
          element_count: 1,
          boundary_face_start: 0,
          boundary_face_count: 4,
        },
      ],
    });

    expect(merged?.mesh_parts).toHaveLength(1);
    expect(merged?.object_segments).toHaveLength(1);
    expect(merged?.nodes).toEqual(resourceMesh.nodes);
  });

  it("drops stale metadata when the mesh identity changes", () => {
    const currentMesh = buildFemMeshFromDecodedTopology(
      makeDecodedTopology(),
      makeSummary(),
    );
    const nextMesh = buildFemMeshFromDecodedTopology(
      makeDecodedTopology(),
      makeSummary({
        mesh_id: "mesh-2",
        generation_id: "gen-2",
      }),
    );
    const merged = mergeFemMeshResource(nextMesh, {
      ...currentMesh,
      mesh_parts: [
        {
          id: "stale-part",
          label: "stale-part",
          role: "magnetic_object",
          object_id: "stale",
          geometry_id: "stale",
          material_id: "stale",
          element_start: 0,
          element_count: 1,
          boundary_face_start: 0,
          boundary_face_count: 4,
          boundary_face_indices: [0, 1, 2, 3],
          node_start: 0,
          node_count: 4,
          node_indices: [0, 1, 2, 3],
          surface_faces: [[0, 1, 2]],
          bounds_min: [0, 0, 0],
          bounds_max: [1, 1, 1],
        },
      ],
    });

    expect(merged?.generation_id).toBe("gen-2");
    expect(merged?.mesh_parts ?? []).toHaveLength(0);
  });
});
