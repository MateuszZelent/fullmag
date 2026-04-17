import { describe, expect, it } from "vitest";

import {
  collectSegments,
  collectSliceTopology,
  sampleSliceField,
  type SlicePlane,
} from "../femSliceGeometry";
import type { FemMeshData } from "../femMeshTypes";

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
});
