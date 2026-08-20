import { describe, expect, it } from "vitest";

import type {
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";

import {
  buildMeshQualityVertexColors,
  evictMeshQualityColorCacheEntriesForTests,
} from "./viewport3dQualityMapping";
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

  it("keeps palette-specific mesh quality buffers separate", () => {
    const topology = topologyFixture();
    const quality = qualityFixture();

    const viridis = buildMeshQualityVertexColors(
      topology,
      quality,
      "gamma",
      "viridis",
    );
    const inferno = buildMeshQualityVertexColors(
      topology,
      quality,
      "gamma",
      "inferno",
    );

    expect(viridis).not.toBe(inferno);
    expect(Array.from(inferno?.colors.slice(0, 3) ?? [])).toEqual(
      Array.from(Float32Array.from(magnitudeColorRgb(0, "inferno"))),
    );
  });

  it("bounds mesh quality color cache entries when palette changes", () => {
    const topology = topologyFixture();
    const quality = qualityFixture();
    const before =
      memoryBudgetRegistry.snapshot().find(
        (entry) => entry.id === "viewport3d.render.meshQualityColorCache",
      )?.entryCount ?? 0;

    for (let index = 0; index < 20; index += 1) {
      buildMeshQualityVertexColors(
        topology,
        quality,
        "gamma",
        `palette-${index}`,
      );
    }

    const after =
      memoryBudgetRegistry.snapshot().find(
        (entry) => entry.id === "viewport3d.render.meshQualityColorCache",
      )?.entryCount ?? 0;

    expect(after - before).toBeLessThanOrEqual(8);
  });

  it("evicts mesh quality colors by byte budget before the count limit", () => {
    const entry = {
      oldest: { colors: new Float32Array(4), range: { min: 0, max: 1 } },
      newest: { colors: new Float32Array(4), range: { min: 0, max: 1 } },
    };

    evictMeshQualityColorCacheEntriesForTests(entry, 8, 16);

    expect(Object.keys(entry)).toEqual(["newest"]);
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

  it("fails closed instead of normalizing mixed-family quality together", () => {
    const topology = topologyFixture();
    topology.cellCount = 2;
    topology.cellNodes = new Uint32Array([
      0, 1, 2, 3,
      0, 1, 2, 3, 4, 5,
    ]);
    topology.cellOffsets = new Uint32Array([0, 4, 10]);
    topology.cellTypes = new Uint32Array([1, 2]);
    topology.indices = new Uint32Array();
    topology.nodeCount = 6;
    topology.positions = new Float64Array(18);

    const colors = buildMeshQualityVertexColors(
      topology,
      qualityFixture(),
      "gamma",
    );

    expect(colors).toBeNull();
  });

  it("rejects homogeneous prism quality because FMMQ is tet4-only", () => {
    const topology = topologyFixture();
    topology.cellCount = 2;
    topology.cellNodes = new Uint32Array([
      0, 1, 2, 3, 4, 5,
      1, 2, 3, 4, 5, 6,
    ]);
    topology.cellOffsets = new Uint32Array([0, 6, 12]);
    topology.cellTypes = new Uint32Array([2, 2]);
    topology.indices = new Uint32Array();
    topology.nodeCount = 7;
    topology.positions = new Float64Array(21);

    const colors = buildMeshQualityVertexColors(topology, qualityFixture(), "gamma");

    expect(colors).toBeNull();
  });
});
