import { describe, expect, it } from "vitest";

import type { DecodedTopology } from "@/kernel/api/codecs";

import {
  buildViewport3DTopologyIndexBundle,
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
      boundary_face_count: 0,
      boundary_face_start: 0,
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
});
