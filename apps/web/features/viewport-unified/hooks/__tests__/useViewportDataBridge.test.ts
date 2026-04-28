import { describe, expect, it } from "vitest";

import { buildViewportFitSeed } from "../useViewportDataBridge";

describe("buildViewportFitSeed", () => {
  it("stays stable across presentation mode changes and only tracks topology-relevant inputs", () => {
    const base = buildViewportFitSeed({
      resolvedFemTopologyKey: "gen:42",
      scaledFemMeshData: {
        nNodes: 128,
        nElements: 96,
        boundaryFaces: new Array(24).fill(0),
      },
    });

    const sameTopology = buildViewportFitSeed({
      resolvedFemTopologyKey: "gen:42",
      scaledFemMeshData: {
        nNodes: 128,
        nElements: 96,
        boundaryFaces: new Array(24).fill(1),
      },
    });

    const newTopology = buildViewportFitSeed({
      resolvedFemTopologyKey: "gen:43",
      scaledFemMeshData: {
        nNodes: 128,
        nElements: 96,
        boundaryFaces: new Array(24).fill(0),
      },
    });

    expect(base).toBe(sameTopology);
    expect(newTopology).not.toBe(base);
  });
});
