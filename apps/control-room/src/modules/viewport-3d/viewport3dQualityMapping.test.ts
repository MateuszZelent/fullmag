import { describe, expect, it } from "vitest";

import type {
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";

import { buildMeshQualityVertexColors } from "./viewport3dQualityMapping";
import { magnitudeColorRgb } from "./viewport3dVectorColoring";

function topologyFixture(): DecodedTopology {
  return {
    boundaryFaceCount: 0,
    boundaryFaces: new Uint32Array(),
    boundaryMarkers: new Uint32Array(),
    elementCount: 2,
    elementMarkers: new Uint32Array([1, 1]),
    indices: new Uint32Array([0, 1, 2, 3, 1, 2, 3, 4]),
    nodeCount: 5,
    positions: new Float64Array(15),
  };
}

function qualityFixture(): DecodedMeshQualityData {
  return {
    elementCount: 2,
    gamma: new Float64Array([0, 1]),
    sicn: new Float64Array([0.2, 0.8]),
    volume: null,
  };
}

describe("buildMeshQualityVertexColors", () => {
  it("averages per-element quality onto shared topology nodes", () => {
    const colors = buildMeshQualityVertexColors(
      topologyFixture(),
      qualityFixture(),
      "gamma",
    );

    expect(colors?.range).toEqual({ max: 1, min: 0 });
    expect(Array.from(colors?.colors ?? [])).toEqual(
      Array.from(Float32Array.from([
        ...magnitudeColorRgb(0),
        ...magnitudeColorRgb(0.5),
        ...magnitudeColorRgb(0.5),
        ...magnitudeColorRgb(0.5),
        ...magnitudeColorRgb(1),
      ])),
    );
  });

  it("reuses vertex color buffers for the same topology, quality, and metric", () => {
    const topology = topologyFixture();
    const quality = qualityFixture();

    const first = buildMeshQualityVertexColors(topology, quality, "gamma");
    const second = buildMeshQualityVertexColors(topology, quality, "gamma");
    const differentMetric = buildMeshQualityVertexColors(topology, quality, "sicn");
    const differentQuality = buildMeshQualityVertexColors(
      topology,
      { ...quality, gamma: new Float64Array([0.1, 0.9]) },
      "gamma",
    );

    expect(first).toBe(second);
    expect(first).not.toBe(differentMetric);
    expect(first).not.toBe(differentQuality);
  });

  it("rejects missing metric arrays and element-count drift", () => {
    expect(
      buildMeshQualityVertexColors(topologyFixture(), qualityFixture(), "volume"),
    ).toBeNull();
    expect(
      buildMeshQualityVertexColors(
        topologyFixture(),
        { ...qualityFixture(), elementCount: 1 },
        "gamma",
      ),
    ).toBeNull();
  });
});
