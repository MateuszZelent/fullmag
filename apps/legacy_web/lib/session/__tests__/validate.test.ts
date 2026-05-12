import { describe, expect, it } from "vitest";

import { validateFemMeshPayload } from "../validate";
import type { FemLiveMesh } from "../types";

function makeBufferedMesh(overrides: Partial<FemLiveMesh> = {}): FemLiveMesh {
  return {
    mesh_id: "mesh-1",
    nodes: [],
    elements: [],
    boundary_faces: [],
    topology_buffers: {
      nodes: new Float64Array(6),
      elements: new Uint32Array(4),
      boundary_faces: new Uint32Array(3),
      element_markers: new Uint32Array(1),
      boundary_markers: new Uint32Array(1),
    },
    mesh_parts: [
      {
        id: "part-1",
        label: "Part 1",
        role: "magnetic_object",
        object_id: "obj-1",
        geometry_id: null,
        material_id: null,
        element_start: 0,
        element_count: 1,
        boundary_face_start: 0,
        boundary_face_count: 1,
        boundary_face_indices: [],
        node_start: 0,
        node_count: 2,
        node_indices: [],
        surface_faces: [],
        bounds_min: null,
        bounds_max: null,
      },
    ],
    ...overrides,
  };
}

describe("validateFemMeshPayload", () => {
  it("validates ranges against topology buffers before legacy arrays", () => {
    expect(validateFemMeshPayload(makeBufferedMesh())).toEqual([]);
  });

  it("reports range errors using buffered counts", () => {
    expect(
      validateFemMeshPayload(
        makeBufferedMesh({
          mesh_parts: [
            {
              id: "too-large",
              label: "too-large",
              role: "magnetic_object",
              object_id: null,
              geometry_id: null,
              material_id: null,
              element_start: 1,
              element_count: 1,
              boundary_face_start: 1,
              boundary_face_count: 1,
              boundary_face_indices: [],
              node_start: 2,
              node_count: 1,
              node_indices: [],
              surface_faces: [],
              bounds_min: null,
              bounds_max: null,
            },
          ],
        }),
      ),
    ).toEqual([
      "part too-large element range exceeds mesh",
      "part too-large boundary_face range exceeds mesh",
      "part too-large node range exceeds mesh",
    ]);
  });
});
