/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import { buildMagneticArrowNodeMask } from "../femSelectionMap";
import type { RenderLayer } from "../femRenderModel";
import type { FemMeshPart, FemLiveMeshObjectSegment } from "@/lib/session/types";

function makePart(partial: Partial<FemMeshPart>): FemMeshPart {
  return {
    id: "part-1",
    label: "Part",
    role: "magnetic_object",
    object_id: "obj-1",
    geometry_id: "geo-1",
    material_id: "mat-1",
    element_start: 0,
    element_count: 1,
    boundary_face_start: 0,
    boundary_face_count: 1,
    boundary_face_indices: [0],
    node_start: 0,
    node_count: 3,
    node_indices: [0, 1, 2],
    surface_faces: [[0, 1, 2]],
    bounds_min: [0, 0, 0],
    bounds_max: [1, 1, 1],
    ...partial,
  };
}

function makeLayer(overrides: Partial<RenderLayer> & { part: FemMeshPart }): RenderLayer {
  return {
    viewState: { visible: true, renderMode: "surface", opacity: 100, colorField: "orientation" },
    boundaryFaceIndices: null,
    elementIndices: null,
    nodeMask: null,
    surfaceFaces: null,
    isPrimaryForCamera: false,
    isMagnetic: overrides.part.role === "magnetic_object",
    isSelected: false,
    isDimmed: false,
    meshColor: "#ffffff",
    edgeColor: "#000000",
    ...overrides,
  };
}

function makeSegment(partial: Partial<FemLiveMeshObjectSegment>): FemLiveMeshObjectSegment {
  return {
    object_id: "obj-1",
    boundary_face_start: 0,
    boundary_face_count: 0,
    element_start: 0,
    element_count: 0,
    node_start: 0,
    node_count: 0,
    ...partial,
  } as FemLiveMeshObjectSegment;
}

describe("buildMagneticArrowNodeMask", () => {
  // P5-3 / D-06: Uint8Array masks work correctly
  it("returns combined magnetic layer masks as Uint8Array", () => {
    const mag = makePart({ id: "mag-1", node_start: 0, node_count: 3 });
    const mask = new Uint8Array(5);
    mask[0] = 1;
    mask[1] = 1;
    mask[2] = 1;
    const layer = makeLayer({ part: mag, nodeMask: mask, isMagnetic: true });

    const result = buildMagneticArrowNodeMask(
      [layer],
      [],
      new Set(),
      5,
      null,
      true, // hasMeshParts
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.length).toBe(5);
    expect(result![0]).toBe(1);
    expect(result![1]).toBe(1);
    expect(result![2]).toBe(1);
    expect(result![3]).toBe(0);
    expect(result![4]).toBe(0);
  });

  // D-07 fix: No visible magnetic layers → empty mask, not activeMask fallback
  it("returns empty mask when no magnetic layers are visible (hasMeshParts)", () => {
    const air = makePart({ id: "air-1", role: "air" });
    const layer = makeLayer({ part: air, isMagnetic: false });

    const result = buildMagneticArrowNodeMask(
      [layer],
      [],
      new Set(),
      10,
      [true, true, true, true, true, true, true, true, true, true],
      true,
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.length).toBe(10);
    // All zeros — empty mask, not broad activeMask fallback
    expect(Array.from(result!).every((v) => v === 0)).toBe(true);
  });

  // D-07 fix: No matching segments → empty mask
  it("returns empty mask when no segment matches (!hasMeshParts)", () => {
    const result = buildMagneticArrowNodeMask(
      [],
      [makeSegment({ object_id: "other", node_start: 0, node_count: 5 })],
      new Set(["missing-id"]),
      10,
      [true, true, true, true, true, true, true, true, true, true],
      false,
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.length).toBe(10);
    expect(Array.from(result!).every((v) => v === 0)).toBe(true);
  });

  // Intersection with activeMask works correctly
  it("intersects combined layers with activeMask", () => {
    const mag = makePart({ id: "mag-1" });
    const nodeMask = new Uint8Array(5);
    nodeMask[0] = 1;
    nodeMask[1] = 1;
    nodeMask[2] = 1;
    nodeMask[3] = 1;
    nodeMask[4] = 1;
    const layer = makeLayer({ part: mag, nodeMask, isMagnetic: true });

    // activeMask masks out nodes 3 and 4
    const activeMask = [true, true, true, false, false];

    const result = buildMagneticArrowNodeMask(
      [layer],
      [],
      new Set(),
      5,
      activeMask,
      true,
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result![0]).toBe(1);
    expect(result![1]).toBe(1);
    expect(result![2]).toBe(1);
    expect(result![3]).toBe(0);
    expect(result![4]).toBe(0);
  });

  // Multiple magnetic layers combine their masks
  it("combines node masks from multiple magnetic layers", () => {
    const mag1 = makePart({ id: "mag-1" });
    const mag2 = makePart({ id: "mag-2" });
    const mask1 = new Uint8Array(6);
    mask1[0] = 1;
    mask1[1] = 1;
    const mask2 = new Uint8Array(6);
    mask2[4] = 1;
    mask2[5] = 1;

    const layer1 = makeLayer({ part: mag1, nodeMask: mask1, isMagnetic: true });
    const layer2 = makeLayer({ part: mag2, nodeMask: mask2, isMagnetic: true });

    const result = buildMagneticArrowNodeMask(
      [layer1, layer2],
      [],
      new Set(),
      6,
      null,
      true,
    );

    expect(result![0]).toBe(1);
    expect(result![1]).toBe(1);
    expect(result![2]).toBe(0);
    expect(result![3]).toBe(0);
    expect(result![4]).toBe(1);
    expect(result![5]).toBe(1);
  });

  // Segment-based path (!hasMeshParts) with matching segments
  it("builds mask from segments when !hasMeshParts", () => {
    const seg = makeSegment({ object_id: "obj-1", node_start: 2, node_count: 3 });

    const result = buildMagneticArrowNodeMask(
      [],
      [seg],
      new Set(["obj-1"]),
      8,
      null,
      false,
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.length).toBe(8);
    expect(result![0]).toBe(0);
    expect(result![1]).toBe(0);
    expect(result![2]).toBe(1);
    expect(result![3]).toBe(1);
    expect(result![4]).toBe(1);
    expect(result![5]).toBe(0);
  });

  // Hidden all magnetic layers → arrows disappear (all zeros)
  it("all-zeros mask means arrows do not display", () => {
    const result = buildMagneticArrowNodeMask(
      [], // no layers
      [],
      new Set(),
      5,
      null,
      true,
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result!).every((v) => v === 0)).toBe(true);
  });
});
