import { describe, expect, it } from "vitest";
import type { FemMeshData } from "../../fem/femMeshTypes";
import { getSharedVertexColors } from "../femVertexColors";

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
