import { describe, expect, it } from "vitest";
import type { FemMeshData } from "../../fem/femMeshTypes";
import { getSharedVertexColors, shouldUseVertexColorWorker } from "../femVertexColors";

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
