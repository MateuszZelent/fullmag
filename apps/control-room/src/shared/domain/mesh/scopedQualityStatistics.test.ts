import { describe, expect, it } from "vitest";

import type {
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";

import { buildScopedMeshQualityStatistics } from "./scopedQualityStatistics";

function mixedTopologyV2(): DecodedTopology {
  return {
    boundaryFaceCount: 0,
    boundaryFaces: new Uint32Array(),
    boundaryMarkers: new Uint32Array(),
    cellCount: 2,
    cellMarkers: new Uint32Array([1, 0]),
    cellNodes: new Uint32Array([
      0, 1, 2, 3, 4, 5,
      6, 7, 8, 9, 10,
    ]),
    cellOffsets: new Uint32Array([0, 6, 11]),
    cellTypes: new Uint32Array([2, 3]),
    elementCount: 2,
    elementMarkers: new Uint32Array(),
    formatVersion: 2,
    indices: new Uint32Array(),
    nodeCount: 11,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      1, 0, 1,
      0, 1, 1,
      2, 0, 0,
      3, 0, 0,
      3, 1, 0,
      2, 1, 0,
      2.5, 0.5, 1,
    ]),
  };
}

function mixedQuality(): DecodedMeshQualityData {
  return {
    elementCount: 2,
    gamma: new Float64Array([0.7, 0.6]),
    sicn: new Float64Array([0.8, 0.5]),
    volume: new Float64Array([0.5, 1 / 3]),
  };
}

describe("buildScopedMeshQualityStatistics", () => {
  it("uses CSR family edges and fails closed for tetra-only size and centroid semantics", () => {
    const statistics = buildScopedMeshQualityStatistics({
      elementIndices: [0, 1],
      meshName: "mixed-v2",
      quality: mixedQuality(),
      scopeLabel: "shared-domain",
      topology: mixedTopologyV2(),
    });

    expect(statistics).not.toBeNull();
    expect(statistics?.edgeLength).not.toBeNull();
    expect(statistics?.sizeDistributions.map(({ id }) => id)).toEqual([
      "edge_length",
      "volume",
    ]);
    expect(statistics?.sizeDistributions.map(({ label }) => label)).not.toContain(
      "Tetra size",
    );
    expect(statistics?.warnings.join(" ")).toContain("mixed-cell topology");
    expect(statistics?.worstElements).toHaveLength(2);
    expect(statistics?.worstElements.every(({ centroid }) => centroid === null)).toBe(
      true,
    );
    expect(statistics?.worstElements.map(({ volume }) => volume)).toEqual([
      1 / 3,
      0.5,
    ]);
  });
});
