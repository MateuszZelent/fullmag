import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { TopologyMeshLayer } from "./TopologyMeshLayer";

vi.mock("./FallbackTopologyMeshLayer", () => ({
  FallbackTopologyMeshLayer: () => "fallback-topology",
}));

vi.mock("./MeshPartLayer", () => ({
  MeshPartLayer: ({ modeCompositionSnapshot, partModel }: {
    modeCompositionSnapshot?: { status: string } | null;
    partModel: { part: { id: string } };
  }) => (
    <span
      data-mode-status={modeCompositionSnapshot?.status ?? "none"}
      data-part-id={partModel.part.id}
    />
  ),
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
        vectorScale={1}
        vectorStyle={{}}
      />,
    );

    expect(markup).toBe("");
  });

  it("routes an object-scoped modal snapshot only to its matching carrier", () => {
    const part = (id: string, objectId: string) => ({
      edgeIndices: null,
      fullNodeSelection: { nodeIndices: [] },
      part: {
        id,
        object_id: objectId,
      },
      surfaceIndices: new Uint32Array([0, 1, 2]),
      surfaceNodeIndices: new Uint32Array([0, 1, 2]),
      surfaceNodeSelection: { nodeIndices: [0, 1, 2] },
      surfaceTriangleCellTypes: null,
      surfaceTriangleFacetIndices: null,
      surfaceTriangleGlobalCellOrdinals: null,
      volumeEdgeIndices: null,
    }) as never;
    const snapshots = new Map([
      ["object:a", { status: "ready" }],
    ]) as never;
    const markup = renderToStaticMarkup(
      <TopologyMeshLayer
        colors={{} as never}
        fieldModel={null}
        getPartSettings={() => DEFAULT_OBJECT_VISUALIZATION}
        materialProfile={{} as never}
        magnetizationTexturePreviews={new Map()}
        meshQualityColors={null}
        meshQualityOverlayVisible={false}
        modeCompositionFieldLayers={snapshots}
        modeCompositionId="composition:1"
        onSelectPart={() => undefined}
        topologyFreshness="current"
        topologyModel={{
          airboxParts: [],
          fallbackSurfaceEdgeIndices: null,
          fallbackSurfaceIndices: new Uint32Array(),
          fallbackSurfaceNodeIndices: new Uint32Array(),
          fallbackVolumeEdgeIndices: new Uint32Array(),
          magneticParts: [part("part-a", "a"), part("part-b", "b")],
          meshGenerationId: "mesh-1",
          meshRevision: 1,
          meshTopologyHash: "hash-1",
          nodeCount: 3,
          positions: new Float32Array(9),
        }}
        tracker={new Viewport3DResourceTracker()}
        vectorColorMode="orientation"
        vectorScale={1}
        vectorStyle={{}}
      />,
    );

    expect(markup).toContain('data-mode-status="ready" data-part-id="part-a"');
    expect(markup).toContain('data-mode-status="none" data-part-id="part-b"');
  });
});
