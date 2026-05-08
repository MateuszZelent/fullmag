import { describe, expect, it } from "vitest";
import type { FemMeshData } from "../../fem/femMeshTypes";
import {
  FEM_VERTEX_COLOR_CACHE_MAX_ENTRIES,
  getSharedVertexColorCacheStats,
  getSharedVertexColors,
  shouldUseVertexColorWorker,
} from "../femVertexColors";

function meshData(): FemMeshData {
  return {
    nodes: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    elements: new Uint32Array(0),
    boundaryFaces: new Uint32Array([0, 1, 2]),
    nNodes: 3,
    nElements: 0,
    quantityDomain: "surface_only",
  };
}

describe("getSharedVertexColors", () => {
  it("caches quality colors for the same mesh and quality input", () => {
    const mesh = meshData();
    const qualityPerFace = [0.75];

    const first = getSharedVertexColors({
      meshData: mesh,
      field: "quality",
      qualityPerFace,
    });
    const second = getSharedVertexColors({
      meshData: mesh,
      field: "quality",
      qualityPerFace,
    });

    expect(second).toBe(first);
  });

  it("separates quality cache entries by quality array identity", () => {
    const mesh = meshData();
    const first = getSharedVertexColors({
      meshData: mesh,
      field: "sicn",
      qualityPerFace: [0.25],
    });
    const second = getSharedVertexColors({
      meshData: mesh,
      field: "sicn",
      qualityPerFace: [0.25],
    });

    expect(second).not.toBe(first);
  });

  it("bounds field-revision cache entries for one topology", () => {
    const topologyRef = {};
    const mesh = {
      ...meshData(),
      topologyRef,
    } as FemMeshData;

    for (let revision = 1; revision <= FEM_VERTEX_COLOR_CACHE_MAX_ENTRIES + 4; revision += 1) {
      getSharedVertexColors({
        meshData: {
          ...mesh,
          topologyRef,
          fieldRevision: revision,
          fieldData: {
            x: new Float64Array([revision, 0, 0]),
            y: new Float64Array([0, revision, 0]),
            z: new Float64Array([0, 0, revision]),
          },
          fieldNComp: 3,
        } as FemMeshData,
        field: "magnitude",
      });
    }

    expect(getSharedVertexColorCacheStats(mesh).entries).toBeLessThanOrEqual(
      FEM_VERTEX_COLOR_CACHE_MAX_ENTRIES,
    );
  });
});

describe("shouldUseVertexColorWorker", () => {
  it("uses the worker only for enabled large non-uniform color work", () => {
    expect(
      shouldUseVertexColorWorker({
        enabled: true,
        nNodes: 100_000,
        field: "magnitude",
        hasUniformColor: false,
      }),
    ).toBe(true);
    expect(
      shouldUseVertexColorWorker({
        enabled: true,
        nNodes: 99_999,
        field: "magnitude",
        hasUniformColor: false,
      }),
    ).toBe(false);
    expect(
      shouldUseVertexColorWorker({
        enabled: true,
        nNodes: 200_000,
        field: "none",
        hasUniformColor: true,
      }),
    ).toBe(false);
    expect(
      shouldUseVertexColorWorker({
        enabled: false,
        nNodes: 200_000,
        field: "magnitude",
        hasUniformColor: false,
      }),
    ).toBe(false);
  });
});
