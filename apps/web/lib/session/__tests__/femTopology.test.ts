import { describe, expect, it } from "vitest";

import {
  getFemBoundaryFaceCount,
  getFemElementCount,
  getFemNodeCount,
  readFemBoundaryFace,
  readFemElementMarker,
  readFemElementNode,
  readFemNode,
} from "../femTopology";
import type { FemLiveMesh } from "../types";

function makeMesh(overrides: Partial<FemLiveMesh> = {}): FemLiveMesh {
  return {
    mesh_id: "mesh-1",
    nodes: [[100, 100, 100]],
    elements: [[9, 9, 9, 9]],
    element_markers: [99],
    boundary_faces: [[8, 8, 8]],
    boundary_markers: [88],
    topology_buffers: {
      nodes: new Float64Array([0, 0, 0, 1, 0, 0]),
      elements: new Uint32Array([0, 1, 1, 0]),
      boundary_faces: new Uint32Array([0, 1, 0]),
      element_markers: new Uint32Array([7]),
      boundary_markers: new Uint32Array([3]),
    },
    ...overrides,
  };
}

describe("femTopology helpers", () => {
  it("prefer typed topology buffers over legacy tuple arrays", () => {
    const mesh = makeMesh();

    expect(getFemNodeCount(mesh)).toBe(2);
    expect(getFemElementCount(mesh)).toBe(1);
    expect(getFemBoundaryFaceCount(mesh)).toBe(1);
    expect(readFemNode(mesh, 1)).toEqual([1, 0, 0]);
    expect(readFemElementNode(mesh, 0, 1)).toBe(1);
    expect(readFemBoundaryFace(mesh, 0)).toEqual([0, 1, 0]);
    expect(readFemElementMarker(mesh, 0)).toBe(7);
  });

  it("falls back to legacy arrays when buffers are unavailable", () => {
    const mesh = makeMesh({
      topology_buffers: null,
      nodes: [[2, 3, 4]],
      elements: [[0, 0, 0, 0]],
      element_markers: [11],
      boundary_faces: [[0, 0, 0]],
    });

    expect(getFemNodeCount(mesh)).toBe(1);
    expect(getFemElementCount(mesh)).toBe(1);
    expect(getFemBoundaryFaceCount(mesh)).toBe(1);
    expect(readFemNode(mesh, 0)).toEqual([2, 3, 4]);
    expect(readFemElementNode(mesh, 0, 2)).toBe(0);
    expect(readFemBoundaryFace(mesh, 0)).toEqual([0, 0, 0]);
    expect(readFemElementMarker(mesh, 0)).toBe(11);
  });

  it("returns null for out-of-range reads", () => {
    const mesh = makeMesh();

    expect(readFemNode(mesh, -1)).toBeNull();
    expect(readFemNode(mesh, 2)).toBeNull();
    expect(readFemElementNode(mesh, 0, 4)).toBeNull();
    expect(readFemElementNode(mesh, 1, 0)).toBeNull();
    expect(readFemBoundaryFace(mesh, 1)).toBeNull();
    expect(readFemElementMarker(mesh, 1)).toBeNull();
  });
});
