import { describe, expect, it } from "vitest";

import {
  collectSegments,
  collectSliceTopology,
  sampleSliceField,
  type SlicePlane,
} from "../femSliceGeometry";
import { buildSliceVisibilityState } from "../femSliceUtils";
import type { FemMeshData } from "../femMeshTypes";
import type { FemMeshPart } from "../../../../lib/session/types";

function makeMeshData(): FemMeshData {
  return {
    nodes: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ],
    elements: [0, 1, 2, 3],
    boundaryFaces: [],
    nNodes: 4,
    nElements: 1,
    fieldNComp: 3,
    fieldData: {
      x: [1, 1, 1, 1],
      y: [2, 2, 2, 2],
      z: [3, 3, 3, 3],
    },
    quantityDomain: "magnetic_only",
  };
}

describe("collectSegments", () => {
  it.each([
    ["xy", [1, 2] as const],
    ["xz", [1, 3] as const],
    ["yz", [2, 3] as const],
  ] satisfies ReadonlyArray<[SlicePlane, readonly [number, number]]>)(
    "keeps world-vector semantics for %s slices",
    (plane, expectedProjectedVector) => {
      const slice = collectSegments(makeMeshData(), plane, "x", 0.25, null);

      expect(slice.polygons).toHaveLength(1);
      expect(slice.arrows).toHaveLength(1);

      expect(slice.polygons[0].worldVector).toEqual([1, 2, 3]);
      expect(slice.arrows[0].worldVector).toEqual([1, 2, 3]);
      expect(slice.arrows[0].vector).toEqual([...expectedProjectedVector]);
      expect(slice.valueRange).toEqual({ min: 1, max: 1 });
    },
  );

  it("keeps topology stable while resampling field components", () => {
    const meshData = makeMeshData();
    const topology = collectSliceTopology(meshData, "xy", 0.25, null);
    const sliceX = sampleSliceField(meshData, "xy", "x", topology);
    const sliceZ = sampleSliceField(meshData, "xy", "z", topology);

    expect(topology.polygons).toHaveLength(1);
    expect(sliceX.polygons).toHaveLength(1);
    expect(sliceZ.polygons).toHaveLength(1);
    expect(sliceX.polygons[0]?.points).toEqual(topology.polygons[0]?.points);
    expect(sliceZ.polygons[0]?.points).toEqual(topology.polygons[0]?.points);
    expect(sliceX.polygons[0]?.value).toBe(1);
    expect(sliceZ.polygons[0]?.value).toBe(3);
    expect(sliceX.arrows[0]?.vector).toEqual([1, 2]);
    expect(sliceZ.arrows[0]?.vector).toEqual([1, 2]);
  });

  it("keeps airbox slice polygons independently visible from magnetic objects", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        2, 0, 0,
        3, 0, 0,
        2, 1, 0,
        2, 0, 1,
      ],
      elements: [0, 1, 2, 3, 4, 5, 6, 7],
      boundaryFaces: [],
      nNodes: 8,
      nElements: 2,
      fieldNComp: 3,
      fieldData: {
        x: [1, 1, 1, 1, 0, 0, 0, 0],
        y: [0, 0, 0, 0, 0, 0, 0, 0],
        z: [0, 0, 0, 0, 0, 0, 0, 0],
      },
      quantityDomain: "full_domain",
    };
    const basePart = {
      label: "",
      object_id: null,
      geometry_id: null,
      material_id: null,
      boundary_face_start: 0,
      boundary_face_count: 0,
      boundary_face_indices: [],
      node_start: 0,
      node_count: 0,
      node_indices: [],
      surface_faces: [],
      bounds_min: null,
      bounds_max: null,
    } satisfies Omit<FemMeshPart, "id" | "role" | "element_start" | "element_count">;
    const meshParts: FemMeshPart[] = [
      {
        ...basePart,
        id: "mag",
        label: "magnetic",
        role: "magnetic_object",
        object_id: "body",
        element_start: 0,
        element_count: 1,
      },
      {
        ...basePart,
        id: "air",
        label: "airbox",
        role: "air",
        element_start: 1,
        element_count: 1,
      },
      {
        ...basePart,
        id: "outer",
        label: "outer boundary",
        role: "outer_boundary",
        element_start: 1,
        element_count: 1,
      },
    ];

    const visibleAir = buildSliceVisibilityState({
      meshData,
      meshParts,
      meshEntityViewState: {
        air: { visible: true, renderMode: "wireframe", opacity: 28, colorField: "none" },
      },
      airSegmentVisible: true,
      objectViewMode: "context",
      visibleObjectIds: ["body"],
      vectorDomainFilter: "full_domain",
    });
    const hiddenAir = buildSliceVisibilityState({
      meshData,
      meshParts,
      meshEntityViewState: {
        air: { visible: true, renderMode: "wireframe", opacity: 28, colorField: "none" },
      },
      airSegmentVisible: false,
      objectViewMode: "context",
      visibleObjectIds: ["body"],
      vectorDomainFilter: "full_domain",
    });

    expect(
      collectSliceTopology(meshData, "xy", 0.25, visibleAir).polygons.map(
        (polygon) => polygon.partId,
      ),
    ).toEqual(["mag", "outer"]);
    expect(
      collectSliceTopology(meshData, "xy", 0.25, hiddenAir).polygons.map(
        (polygon) => polygon.partId,
      ),
    ).toEqual(["mag"]);
  });

  it("does not use vector domain filtering to hide 2D airbox geometry", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        2, 0, 0,
        3, 0, 0,
        2, 1, 0,
        2, 0, 1,
      ],
      elements: [0, 1, 2, 3, 4, 5, 6, 7],
      boundaryFaces: [],
      nNodes: 8,
      nElements: 2,
      fieldNComp: 3,
      fieldData: {
        x: [1, 1, 1, 1, 0, 0, 0, 0],
        y: [0, 0, 0, 0, 0, 0, 0, 0],
        z: [0, 0, 0, 0, 0, 0, 0, 0],
      },
      quantityDomain: "magnetic_only",
    };
    const basePart = {
      label: "",
      object_id: null,
      geometry_id: null,
      boundary_face_start: 0,
      boundary_face_count: 0,
      boundary_face_indices: [],
      node_start: 0,
      node_count: 0,
      node_indices: [],
      surface_faces: [],
      bounds_min: null,
      bounds_max: null,
    } satisfies Omit<FemMeshPart, "id" | "role" | "element_start" | "element_count">;
    const meshParts: FemMeshPart[] = [
      {
        ...basePart,
        id: "mag",
        label: "magnetic",
        role: "magnetic_object",
        object_id: "body",
        element_start: 0,
        element_count: 1,
      },
      {
        ...basePart,
        id: "air",
        label: "airbox",
        role: "air",
        element_start: 1,
        element_count: 1,
      },
    ];

    const visibleAir = buildSliceVisibilityState({
      meshData,
      meshParts,
      meshEntityViewState: {
        air: { visible: true, renderMode: "wireframe", opacity: 28, colorField: "none" },
      },
      airSegmentVisible: true,
      objectViewMode: "context",
      visibleObjectIds: ["body"],
      vectorDomainFilter: "magnetic_only",
    });

    expect(
      collectSliceTopology(meshData, "xy", 0.25, visibleAir).polygons.map(
        (polygon) => polygon.partId,
      ),
    ).toEqual(["mag", "air"]);
  });
});
