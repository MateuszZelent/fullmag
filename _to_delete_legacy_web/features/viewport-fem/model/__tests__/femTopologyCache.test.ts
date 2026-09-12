/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import {
  collectPartBoundaryFaceIndices,
  collectPartElementIndices,
  collectPartNodeMask,
  buildPartRenderDataCache,
} from "../femTopologyCache";
import type { FemMeshPart } from "@/lib/session/types";

function makePart(partial: Partial<FemMeshPart>): FemMeshPart {
  return {
    id: "part-1",
    label: "Part",
    role: "magnetic_object",
    object_id: "obj-1",
    geometry_id: "geo-1",
    material_id: "mat-1",
    element_start: 0,
    element_count: 0,
    boundary_face_start: 0,
    boundary_face_count: 0,
    boundary_face_indices: [],
    node_start: 0,
    node_count: 0,
    node_indices: [],
    surface_faces: [],
    bounds_min: [0, 0, 0],
    bounds_max: [1, 1, 1],
    ...partial,
  };
}

describe("subset semantics (Z-03: null vs [] vs [a,b,c])", () => {
  describe("collectPartBoundaryFaceIndices", () => {
    it("returns [] for a part with zero boundary faces", () => {
      const part = makePart({ boundary_face_count: 0, boundary_face_start: 0 });
      const result = collectPartBoundaryFaceIndices(part, 100);
      expect(result).toEqual([]);
    });

    it("returns null when part covers all faces (full mesh)", () => {
      const part = makePart({ boundary_face_start: 0, boundary_face_count: 10 });
      const result = collectPartBoundaryFaceIndices(part, 10);
      expect(result).toBeNull();
    });

    it("returns specific indices for a proper subset", () => {
      const part = makePart({ boundary_face_start: 2, boundary_face_count: 3 });
      const result = collectPartBoundaryFaceIndices(part, 100);
      expect(result).toEqual([2, 3, 4]);
    });

    it("uses boundary_face_indices when available", () => {
      const part = makePart({ boundary_face_indices: [5, 10, 15] });
      const result = collectPartBoundaryFaceIndices(part, 100);
      expect(result).toEqual([5, 10, 15]);
    });

    it("filters out-of-range indices", () => {
      const part = makePart({ boundary_face_indices: [0, 5, 200] });
      const result = collectPartBoundaryFaceIndices(part, 10);
      expect(result).toEqual([0, 5]);
    });
  });

  describe("collectPartElementIndices", () => {
    it("returns [] for a part with zero elements", () => {
      const part = makePart({ element_start: 0, element_count: 0 });
      const result = collectPartElementIndices(part, 100);
      expect(result).toEqual([]);
    });

    it("returns null when part covers all elements (full mesh)", () => {
      const part = makePart({ element_start: 0, element_count: 50 });
      const result = collectPartElementIndices(part, 50);
      expect(result).toBeNull();
    });

    it("returns specific indices for a proper subset", () => {
      const part = makePart({ element_start: 10, element_count: 3 });
      const result = collectPartElementIndices(part, 100);
      expect(result).toEqual([10, 11, 12]);
    });
  });

  describe("collectPartNodeMask", () => {
    it("returns null for a part with zero nodes", () => {
      const part = makePart({ node_start: 0, node_count: 0 });
      const result = collectPartNodeMask(part, 10);
      expect(result).toBeNull();
    });

    it("returns Uint8Array mask for a part with nodes", () => {
      const part = makePart({ node_start: 2, node_count: 3 });
      const result = collectPartNodeMask(part, 10);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result!.length).toBe(10);
      expect(result![0]).toBe(0);
      expect(result![1]).toBe(0);
      expect(result![2]).toBe(1);
      expect(result![3]).toBe(1);
      expect(result![4]).toBe(1);
      expect(result![5]).toBe(0);
    });

    it("uses node_indices when available", () => {
      const part = makePart({ node_indices: [1, 3, 7] });
      const result = collectPartNodeMask(part, 10);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result![1]).toBe(1);
      expect(result![3]).toBe(1);
      expect(result![7]).toBe(1);
      expect(result![0]).toBe(0);
      expect(result![2]).toBe(0);
    });

    it("filters out-of-range node_indices", () => {
      const part = makePart({ node_indices: [0, 2, 999] });
      const result = collectPartNodeMask(part, 5);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result![0]).toBe(1);
      expect(result![2]).toBe(1);
      // 999 is out of range, should be ignored
    });
  });
});

describe("buildPartRenderDataCache", () => {
  it("builds cache for multiple parts", () => {
    const p1 = makePart({
      id: "p1",
      boundary_face_start: 0,
      boundary_face_count: 3,
      element_start: 0,
      element_count: 2,
      node_start: 0,
      node_count: 4,
    });
    const p2 = makePart({
      id: "p2",
      boundary_face_start: 3,
      boundary_face_count: 2,
      element_start: 2,
      element_count: 1,
      node_start: 4,
      node_count: 3,
    });

    // boundaryFaceArrayLength = faces*3 = 15 (5 faces = 15 coords)
    const cache = buildPartRenderDataCache([p1, p2], 15, 10, 10);

    expect(cache.size).toBe(2);
    expect(cache.has("p1")).toBe(true);
    expect(cache.has("p2")).toBe(true);

    const d1 = cache.get("p1")!;
    expect(d1.boundaryFaceIndices).toEqual([0, 1, 2]);
    expect(d1.elementIndices).toEqual([0, 1]);
    expect(d1.nodeMask).toBeInstanceOf(Uint8Array);

    const d2 = cache.get("p2")!;
    expect(d2.boundaryFaceIndices).toEqual([3, 4]);
    expect(d2.elementIndices).toEqual([2]);
  });

  it("returns empty cache for empty parts", () => {
    const cache = buildPartRenderDataCache([], 30, 10, 10);
    expect(cache.size).toBe(0);
  });
});
