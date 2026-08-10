import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { TopologyMeshLayer } from "./TopologyMeshLayer";

vi.mock("./FallbackTopologyMeshLayer", () => ({
  FallbackTopologyMeshLayer: () => "fallback-topology",
}));

vi.mock("./MeshPartLayer", () => ({
  MeshPartLayer: () => "mesh-part",
}));

describe("TopologyMeshLayer", () => {
  it("fails closed instead of rendering global FEM topology without magnetic carriers", () => {
    const markup = renderToStaticMarkup(
      <TopologyMeshLayer
        colors={{} as never}
        fieldModel={null}
        getPartSettings={() => DEFAULT_OBJECT_VISUALIZATION}
        materialProfile={{} as never}
        magnetizationTexturePreviews={new Map()}
        meshQualityColors={null}
        meshQualityOverlayVisible={false}
        onSelectPart={() => undefined}
        topologyFreshness="current"
        topologyModel={{
          airboxParts: [],
          fallbackSurfaceEdgeIndices: new Uint32Array(),
          fallbackSurfaceIndices: new Uint32Array([0, 1, 2]),
          fallbackSurfaceNodeIndices: new Uint32Array([0, 1, 2]),
          fallbackVolumeEdgeIndices: new Uint32Array(),
          magneticParts: [],
          meshGenerationId: "mesh-1",
          meshRevision: 1,
          meshTopologyHash: "hash-1",
          nodeCount: 3,
          positions: new Float32Array(9),
        }}
        tracker={new Viewport3DResourceTracker()}
        vectorColorMode="orientation"
        vectorStyle={{}}
      />,
    );

    expect(markup).toBe("");
  });
});
