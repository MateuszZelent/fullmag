import { describe, expect, it } from "vitest";

import {
  collectSegments,
  collectSliceTopology,
  computeProjectionSlice,
  sampleSliceField,
  type SlicePlane,
} from "../femSliceGeometry";
import {
  buildQuantityExtentMask,
  buildSliceVisibilityState,
} from "../femSliceUtils";
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

  it("returns a visible boundary slice for the xz plane at the minimum normal coordinate", () => {
    const meshData = makeMeshData();

    const slice = collectSegments(meshData, "xz", "x", 0, null);

    expect(slice.polygons).toHaveLength(1);
    expect(slice.polygons[0]?.points).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(slice.normalLabel).toBe("y");
    expect(slice.uLabel).toBe("x");
    expect(slice.vLabel).toBe("z");
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

  it("uses only magnetic elements for quantity extent when quantity is magnetic-only", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        20, 0, 0,
        30, 0, 0,
        20, 5, 0,
        20, 0, 6,
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
    ];

    const visibility = buildSliceVisibilityState({
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

    expect(Array.from(visibility.visibleElements ?? [])).toEqual([1, 1]);
    expect(
      Array.from(
        buildQuantityExtentMask({
          visibility,
          quantityDomain: meshData.quantityDomain,
        }) ?? [],
      ),
    ).toEqual([1, 0]);
  });

  it("supports explicit all-layer projection reductions", () => {
    const meshData = makeMeshData();
    // Use resolution=4 + nPlanes=4 so polygon-fill rasterizer places cell
    // centers inside intersection polygons (the tetra is small and at z=0.5
    // the XY triangle doesn't cover cell (0.5,0.5) at resolution=1).
    const mean = computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      nPlanes: 4,
      resolution: 4,
      reduction: "mean_occupied",
    });
    const sum = computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      nPlanes: 4,
      resolution: 4,
      reduction: "sum",
    });
    const integral = computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      nPlanes: 4,
      resolution: 4,
      reduction: "thickness_integral",
    });

    // Find a populated cell
    const meanVal = Array.from(mean.values).find(v => !Number.isNaN(v));
    const sumVal = Array.from(sum.values).find(v => !Number.isNaN(v));
    const integralVal = Array.from(integral.values).find(v => !Number.isNaN(v));

    expect(meanVal).toBeCloseTo(1);
    expect(sumVal).toBeDefined();
    expect(sumVal!).toBeGreaterThan(1);
    expect(integralVal).toBeDefined();
  });

  it("limits projection element sampling when a preview budget is set", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ],
      elements: [0, 1, 2, 3, 4, 5, 6, 7],
      boundaryFaces: [],
      nNodes: 8,
      nElements: 2,
      fieldNComp: 3,
      fieldData: {
        x: [1, 1, 1, 1, 3, 3, 3, 3],
        y: [0, 0, 0, 0, 0, 0, 0, 0],
        z: [0, 0, 0, 0, 0, 0, 0, 0],
      },
      quantityDomain: "magnetic_only",
    };

    const full = computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      nPlanes: 4,
      resolution: 4,
      reduction: "sum",
    });
    const budgeted = computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      nPlanes: 4,
      resolution: 4,
      maxElements: 1,
      reduction: "sum",
    });

    // Full should have higher or equal values than budgeted (sees both elements)
    const fullVals = Array.from(full.values).filter(v => !Number.isNaN(v));
    const budgetedVals = Array.from(budgeted.values).filter(v => !Number.isNaN(v));
    expect(fullVals.length).toBeGreaterThan(0);
    expect(budgetedVals.length).toBeGreaterThan(0);
    // Full sees both elements (values 1 and 3), budgeted sees only 1
    const fullMax = Math.max(...fullVals);
    const budgetedMax = Math.max(...budgetedVals);
    expect(fullMax).toBeGreaterThanOrEqual(budgetedMax);
  });

  it("supports extrema and statistical all-layer projection reductions", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ],
      elements: [0, 1, 2, 3, 4, 5, 6, 7],
      boundaryFaces: [],
      nNodes: 8,
      nElements: 2,
      fieldNComp: 3,
      fieldData: {
        x: [1, 1, 1, 1, 3, 3, 3, 3],
        y: [0, 0, 0, 0, 0, 0, 0, 0],
        z: [0, 0, 0, 0, 0, 0, 0, 0],
      },
      quantityDomain: "magnetic_only",
    };
    // Use resolution=4 so polygon-fill rasterizer places cell centers
    // inside the small intersection triangles.
    const options = { nPlanes: 4, resolution: 4 } as const;

    const findFinite = (vals: Float64Array) => Array.from(vals).find(v => !Number.isNaN(v));

    const minVal = findFinite(computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      ...options,
      reduction: "min",
    }).values);
    expect(minVal).toBeCloseTo(1);

    const maxVal = findFinite(computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      ...options,
      reduction: "max",
    }).values);
    expect(maxVal).toBeCloseTo(3);

    const rmsVal = findFinite(computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      ...options,
      reduction: "rms",
    }).values);
    expect(rmsVal).toBeDefined();
    expect(rmsVal!).toBeGreaterThan(0);

    const absMaxVal = findFinite(computeProjectionSlice(meshData, "xy", "x", null, "visible-context", {
      ...options,
      reduction: "abs_max",
    }).values);
    expect(absMaxVal).toBeCloseTo(3);
  });
});
