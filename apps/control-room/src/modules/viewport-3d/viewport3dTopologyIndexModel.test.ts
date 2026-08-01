import { describe, expect, it } from "vitest";

import type { DecodedTopology } from "@/kernel/api/codecs";

import {
  buildPartSurfaceIndices,
  buildViewport3DTopologyIndexBundle,
  transferablesForTopologyIndexBundle,
  type Viewport3DTopologyIndexPartInput,
} from "./viewport3dTopologyIndexModel";

function topologyFixture(): DecodedTopology {
  return {
    boundaryFaceCount: 2,
    boundaryFaces: new Uint32Array([0, 1, 2, 1, 2, 3]),
    boundaryMarkers: new Uint32Array(),
    elementCount: 1,
    elementMarkers: new Uint32Array([1]),
    indices: new Uint32Array([0, 1, 2, 3]),
    nodeCount: 4,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
  };
}

describe("viewport3dTopologyIndexModel", () => {
  it("builds one derived topology index bundle for full topology and parts", () => {
    const magneticPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_start: 0,
      id: "magnet",
      node_count: 4,
      node_start: 0,
    };
    const supplementalPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_indices: [1],
      boundary_face_start: 1,
      id: "magnet-interface",
      surface_faces: [[3, 2, 1]],
    };
    const airboxPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_start: 1,
      id: "airbox",
      surface_node_indices: [0, 3],
    };

    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [airboxPart],
      magneticParts: [magneticPart],
      magneticSurfacePartsByPartId: new Map([["magnet", [supplementalPart]]]),
      topology: topologyFixture(),
    });

    expect(Array.from(bundle.fallbackSurfaceIndices)).toEqual([
      0, 1, 2,
      0, 1, 3,
      0, 2, 3,
      1, 2, 3,
    ]);
    expect(Array.from(bundle.fallbackVolumeEdgeIndices)).toEqual([
      0, 1,
      0, 2,
      0, 3,
      1, 2,
      1, 3,
      2, 3,
    ]);
    expect(Array.from(bundle.fallbackSurfaceEdgeIndices ?? [])).toEqual([
      0, 1,
      1, 2,
      0, 2,
      1, 3,
      0, 3,
      2, 3,
    ]);
    expect(Array.from(bundle.fallbackSurfaceNodeIndices)).toEqual([0, 1, 2, 3]);
    expect(Array.from(bundle.magneticPartsById.get("magnet")?.surfaceIndices ?? []))
      .toEqual([
        0, 1, 2,
        3, 2, 1,
      ]);
    expect(Array.from(bundle.magneticPartsById.get("magnet")?.edgeIndices ?? []))
      .toEqual([
        0, 1,
        1, 2,
        0, 2,
        2, 3,
        1, 3,
      ]);
    expect(
      Array.from(bundle.magneticPartsById.get("magnet")?.surfaceNodeIndices ?? []),
    ).toEqual([0, 1, 2, 3]);
    expect(Array.from(bundle.airboxPartsById.get("airbox")?.surfaceIndices ?? []))
      .toEqual([1, 2, 3]);
    expect(
      Array.from(bundle.airboxPartsById.get("airbox")?.surfaceNodeIndices ?? []),
    ).toEqual([0, 3]);
    expect(bundle.airboxPartsById.get("airbox")?.surfaceNodeSelection).toEqual({
      nodeIndices: [0, 3],
    });
  });

  it("builds mixed tet, prism, and pyramid surfaces and edges from canonical CSR", () => {
    const topology: DecodedTopology = {
      boundaryFaceCount: 2,
      boundaryFaces: new Uint32Array([7, 8, 11, 7, 8, 9, 10, 11]),
      boundaryMarkers: new Uint32Array([1, 2]),
      cellCount: 3,
      cellMarkers: new Uint32Array([1, 1, 2]),
      cellNodes: new Uint32Array([
        0, 1, 2, 3,
        0, 1, 2, 4, 5, 6,
        7, 8, 9, 10, 11,
      ]),
      cellOffsets: new Uint32Array([0, 4, 10, 15]),
      cellTypes: new Uint32Array([1, 2, 3]),
      elementCount: 3,
      elementMarkers: new Uint32Array([1, 1, 2]),
      facetCount: 2,
      facetMarkers: new Uint32Array([1, 2]),
      facetNodes: new Uint32Array([7, 8, 11, 7, 8, 9, 10]),
      facetOffsets: new Uint32Array([0, 3, 7]),
      facetRoles: new Uint32Array([1, 1]),
      facetTypes: new Uint32Array([1, 2]),
      formatVersion: 2,
      indices: new Uint32Array([
        0, 1, 2, 3,
        0, 1, 2, 4, 5, 6,
        7, 8, 9, 10, 11,
      ]),
      nodeCount: 12,
      positions: new Float64Array(36),
    };
    const prismPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 0,
      boundary_face_start: 0,
      element_count: 1,
      element_start: 1,
      id: "prism",
    };
    const pyramidSurface: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 2,
      boundary_face_start: 0,
      id: "pyramid-surface",
    };

    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [prismPart, pyramidSurface],
      topology,
    });

    expect(bundle.fallbackSurfaceIndices).toHaveLength(48);
    expect(bundle.fallbackVolumeEdgeIndices).toHaveLength(40);
    expect(bundle.magneticPartsById.get("prism")?.volumeEdgeIndices).toHaveLength(18);
    expect(Array.from(bundle.magneticPartsById.get("pyramid-surface")?.surfaceIndices ?? []))
      .toEqual([7, 8, 11, 7, 8, 9, 7, 9, 10]);
    expect(Array.from(
      bundle.magneticPartsById.get("pyramid-surface")
        ?.surfaceTriangleFacetIndices ?? [],
    )).toEqual([0, 1, 1]);
    const fallbackEdges = Array.from(bundle.fallbackSurfaceEdgeIndices ?? []);
    const fallbackEdgeKeys = new Set(
      Array.from({ length: fallbackEdges.length / 2 }, (_unused, index) =>
        [fallbackEdges[index * 2], fallbackEdges[index * 2 + 1]]
          .toSorted((left, right) => (left ?? 0) - (right ?? 0))
          .join(":"),
      ),
    );
    expect(fallbackEdgeKeys.has("7:9")).toBe(false);
  });

  it("keeps prism surface faces when facet identity metadata is unavailable", () => {
    const topology: DecodedTopology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      cellCount: 1,
      cellMarkers: new Uint32Array([1]),
      cellNodes: new Uint32Array([0, 1, 2, 3, 4, 5]),
      cellOffsets: new Uint32Array([0, 6]),
      cellTypes: new Uint32Array([2]),
      elementCount: 1,
      elementMarkers: new Uint32Array([1]),
      facetCount: 0,
      facetMarkers: new Uint32Array(),
      facetNodes: new Uint32Array(),
      facetOffsets: new Uint32Array([0]),
      facetRoles: new Uint32Array(),
      facetTypes: new Uint32Array(),
      formatVersion: 2,
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      nodeCount: 6,
      positions: new Float64Array(18),
    };
    const prismPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 0,
      boundary_face_start: 0,
      element_count: 1,
      element_start: 0,
      id: "prism",
      surface_faces: [
        [0, 1, 2],
        [3, 5, 4],
        [0, 3, 4, 1],
        [1, 4, 5, 2],
        [2, 5, 3, 0],
      ],
    };

    const prepared = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [prismPart],
      topology,
    }).magneticPartsById.get("prism");

    expect(prepared?.surfaceIndices).toHaveLength(24);
    expect(prepared?.surfaceNodeIndices).toEqual(
      Uint32Array.from([0, 1, 2, 3, 4, 5]),
    );
    expect(prepared?.surfaceTriangleFacetIndices).toBeNull();
  });

  it("derives exposed prism surface faces when the manifest omits surface metadata", () => {
    const topology: DecodedTopology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      cellCount: 1,
      cellMarkers: new Uint32Array([1]),
      cellNodes: new Uint32Array([0, 1, 2, 3, 4, 5]),
      cellOffsets: new Uint32Array([0, 6]),
      cellTypes: new Uint32Array([2]),
      elementCount: 1,
      elementMarkers: new Uint32Array([1]),
      facetCount: 0,
      facetMarkers: new Uint32Array(),
      facetNodes: new Uint32Array(),
      facetOffsets: new Uint32Array([0]),
      facetRoles: new Uint32Array(),
      facetTypes: new Uint32Array(),
      formatVersion: 2,
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      nodeCount: 6,
      positions: new Float64Array(18),
    };

    const prepared = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [{
        boundary_face_count: 0,
        boundary_face_start: 0,
        element_count: 1,
        element_start: 0,
        id: "prism",
        node_count: 6,
        node_start: 0,
      }],
      topology,
    }).magneticPartsById.get("prism");

    expect(prepared?.surfaceIndices).toHaveLength(24);
    expect(prepared?.surfaceNodeIndices).toEqual(
      Uint32Array.from([0, 1, 2, 3, 4, 5]),
    );
    expect(buildPartSurfaceIndices({
      boundary_face_count: 0,
      boundary_face_start: 0,
      element_count: 1,
      element_start: 0,
      node_count: 6,
      node_start: 0,
    }, topology)).toHaveLength(24);
  });

  it("keeps surface_faces and supplemental quad picking mapped to global facets", () => {
    const topology = topologyFixture();
    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [{
        boundary_face_count: 1,
        boundary_face_indices: [10],
        boundary_face_start: 10,
        id: "production-surface",
        surface_faces: [[0, 1, 2]],
      }],
      magneticSurfacePartsByPartId: new Map([["production-surface", [{
        boundary_face_count: 1,
        boundary_face_indices: [20],
        boundary_face_start: 20,
        id: "supplemental-quad",
        surface_faces: [[0, 1, 3, 2]],
      }]]]),
      topology,
    });
    const prepared = bundle.magneticPartsById.get("production-surface");

    expect(Array.from(prepared?.surfaceTriangleFacetIndices ?? []))
      .toEqual([10, 20, 20]);
    const edges = Array.from(prepared?.edgeIndices ?? []);
    const edgeKeys = new Set(
      Array.from({ length: edges.length / 2 }, (_unused, index) =>
        [edges[index * 2], edges[index * 2 + 1]]
          .toSorted((left, right) => (left ?? 0) - (right ?? 0))
          .join(":"),
      ),
    );
    expect(edgeKeys.has("0:3")).toBe(false);
    expect(edgeKeys.has("1:3")).toBe(true);
    expect(edgeKeys.has("0:2")).toBe(true);
  });

  it("keeps colliding Tri3 and Quad4 render triangles mapped positionally", () => {
    const topology = topologyFixture();
    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [{
        boundary_face_count: 1,
        boundary_face_indices: [4],
        boundary_face_start: 4,
        id: "tri",
        surface_faces: [[0, 1, 2]],
      }],
      magneticSurfacePartsByPartId: new Map([["tri", [{
        boundary_face_count: 1,
        boundary_face_indices: [9],
        boundary_face_start: 9,
        id: "quad",
        surface_faces: [[0, 1, 2, 3]],
      }]]]),
      topology,
    });
    const prepared = bundle.magneticPartsById.get("tri");

    expect(Array.from(prepared?.surfaceIndices ?? []))
      .toEqual([0, 1, 2, 0, 1, 2, 0, 2, 3]);
    expect(Array.from(prepared?.surfaceTriangleFacetIndices ?? []))
      .toEqual([4, 9, 9]);
  });

  it("maps prism, pyramid, and tet surface triangles to exact canonical cells", () => {
    const topology: DecodedTopology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      cellCount: 5,
      cellMarkers: new Uint32Array(5),
      cellGlobalOrdinals: new BigUint64Array([
        BigInt(100),
        BigInt(101),
        BigInt("9007199254740993"),
        BigInt("9007199254740995"),
        BigInt("18446744073709551615"),
      ]),
      cellNodes: new Uint32Array([
        20, 21, 22, 23,
        24, 25, 26, 27,
        0, 1, 2, 3, 4, 5,
        0, 1, 4, 3, 6,
        7, 8, 9, 10,
      ]),
      cellOffsets: new Uint32Array([0, 4, 8, 14, 19, 23]),
      cellTypes: new Uint32Array([1, 1, 2, 3, 1]),
      elementCount: 5,
      elementMarkers: new Uint32Array(5),
      indices: new Uint32Array(),
      nodeCount: 28,
      positions: new Float64Array(84),
    };
    const prismPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_indices: [40],
      boundary_face_start: 40,
      element_count: 1,
      element_start: 2,
      id: "prism",
      surface_faces: [[0, 1, 2]],
    };
    const prismInterface: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_indices: [41],
      boundary_face_start: 41,
      id: "prism-interface",
      surface_faces: [[0, 3, 4, 1]],
    };
    const pyramidPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_indices: [42],
      boundary_face_start: 42,
      element_count: 1,
      element_start: 3,
      id: "pyramid",
      surface_faces: [[0, 1, 6]],
    };
    const tetPart: Viewport3DTopologyIndexPartInput = {
      boundary_face_count: 1,
      boundary_face_indices: [43],
      boundary_face_start: 43,
      element_count: 1,
      element_start: 4,
      id: "tet",
      surface_faces: [[7, 8, 9]],
    };
    const originalCellNodes = Array.from(topology.cellNodes ?? []);
    const originalCellOffsets = Array.from(topology.cellOffsets ?? []);
    const originalCellTypes = Array.from(topology.cellTypes ?? []);

    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [pyramidPart, tetPart],
      magneticParts: [prismPart],
      magneticSurfacePartsByPartId: new Map([
        ["prism", [prismInterface]],
      ]),
      topology,
    });

    const prism = bundle.magneticPartsById.get("prism");
    expect(Array.from(prism?.surfaceTriangleGlobalCellOrdinals ?? [])).toEqual([
      BigInt("9007199254740993"),
      BigInt("9007199254740993"),
      BigInt("9007199254740993"),
    ]);
    expect(Array.from(prism?.surfaceTriangleCellTypes ?? [])).toEqual([2, 2, 2]);
    expect(Array.from(
      bundle.airboxPartsById.get("pyramid")
        ?.surfaceTriangleGlobalCellOrdinals ?? [],
    )).toEqual([BigInt("9007199254740995")]);
    expect(Array.from(
      bundle.airboxPartsById.get("pyramid")?.surfaceTriangleCellTypes ?? [],
    )).toEqual([3]);
    expect(Array.from(
      bundle.airboxPartsById.get("tet")
        ?.surfaceTriangleGlobalCellOrdinals ?? [],
    )).toEqual([BigInt("18446744073709551615")]);
    expect(Array.from(
      bundle.airboxPartsById.get("tet")?.surfaceTriangleCellTypes ?? [],
    )).toEqual([1]);
    expect(Array.from(topology.cellNodes ?? [])).toEqual(originalCellNodes);
    expect(Array.from(topology.cellOffsets ?? [])).toEqual(originalCellOffsets);
    expect(Array.from(topology.cellTypes ?? [])).toEqual(originalCellTypes);

    const transferables = transferablesForTopologyIndexBundle(bundle);
    expect(transferables).toContain(
      prism?.surfaceTriangleGlobalCellOrdinals?.buffer,
    );
    expect(transferables).toContain(prism?.surfaceTriangleCellTypes?.buffer);
  });

  it("fails closed when a rendered face has ambiguous canonical owners", () => {
    const topology: DecodedTopology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      cellCount: 2,
      cellMarkers: new Uint32Array(2),
      cellNodes: new Uint32Array([0, 1, 2, 3, 0, 1, 2, 4]),
      cellOffsets: new Uint32Array([0, 4, 8]),
      cellTypes: new Uint32Array([1, 1]),
      elementCount: 2,
      elementMarkers: new Uint32Array(2),
      indices: new Uint32Array(),
      nodeCount: 5,
      positions: new Float64Array(15),
    };
    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [{
        boundary_face_count: 1,
        boundary_face_indices: [8],
        boundary_face_start: 8,
        element_count: 2,
        element_start: 0,
        id: "ambiguous",
        surface_faces: [[0, 1, 2]],
      }],
      topology,
    });
    const prepared = bundle.magneticPartsById.get("ambiguous");

    expect(Array.from(
      prepared?.surfaceTriangleGlobalCellOrdinals ?? [],
    )).toEqual([BigInt(0)]);
    expect(Array.from(prepared?.surfaceTriangleCellTypes ?? [])).toEqual([0]);
  });

  it("deduplicates rotated and reversed semantic quads before triangulation", () => {
    const topology: DecodedTopology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      cellCount: 1,
      cellGlobalOrdinals: new BigUint64Array([BigInt("9007199254740993")]),
      cellMarkers: new Uint32Array([1]),
      cellNodes: new Uint32Array([0, 1, 2, 3, 4]),
      cellOffsets: new Uint32Array([0, 5]),
      cellTypes: new Uint32Array([3]),
      elementCount: 1,
      elementMarkers: new Uint32Array([1]),
      indices: new Uint32Array(),
      nodeCount: 5,
      positions: new Float64Array(15),
    };
    const bundle = buildViewport3DTopologyIndexBundle({
      airboxParts: [],
      magneticParts: [{
        boundary_face_count: 1,
        boundary_face_indices: [40],
        boundary_face_start: 40,
        element_count: 1,
        element_start: 0,
        id: "pyramid",
        surface_faces: [[0, 3, 2, 1]],
      }],
      magneticSurfacePartsByPartId: new Map([["pyramid", [{
        boundary_face_count: 2,
        boundary_face_indices: [41, 42],
        boundary_face_start: 41,
        id: "duplicates",
        surface_faces: [[2, 1, 0, 3], [1, 2, 3, 0]],
      }]]]),
      topology,
    });
    const prepared = bundle.magneticPartsById.get("pyramid");

    expect(Array.from(prepared?.surfaceIndices ?? [])).toEqual([
      0, 3, 2,
      0, 2, 1,
    ]);
    expect(Array.from(prepared?.surfaceTriangleFacetIndices ?? [])).toEqual([40, 40]);
    expect(Array.from(prepared?.surfaceTriangleGlobalCellOrdinals ?? [])).toEqual([
      BigInt("9007199254740993"),
      BigInt("9007199254740993"),
    ]);
  });
});
