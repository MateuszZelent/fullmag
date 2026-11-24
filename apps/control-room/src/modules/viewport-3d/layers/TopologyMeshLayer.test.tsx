import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { TopologyMeshLayer } from "./TopologyMeshLayer";
import { resolveViewport3DRealizedTopologyObjectIds } from "./Viewport3DScene";
import { shouldRenderPrimitiveObject } from "./PrimitiveObjectLayerModel";

vi.mock("./FallbackTopologyMeshLayer", () => ({
  FallbackTopologyMeshLayer: () => "fallback-topology",
}));

vi.mock("./MeshPartLayer", () => ({
  MeshPartLayer: ({ modeCompositionSnapshot, partModel, renderVisible, settings }: {
    modeCompositionSnapshot?: { status: string } | null;
    renderVisible?: boolean;
    partModel: { part: { id: string } };
    settings: { shaderVisible: boolean; wireframeVisible: boolean };
  }) => (
    <span
      data-mode-status={modeCompositionSnapshot?.status ?? "none"}
      data-part-id={partModel.part.id}
      data-render-visible={renderVisible ?? true}
      data-wireframe-visible={settings.wireframeVisible}
      data-shader-visible={settings.shaderVisible}
    />
  ),
}));

describe("TopologyMeshLayer", () => {
  it("atomically replaces a primitive only after every matching surface upload is committed", () => {
    const object = { objectId: "antenna", role: "antenna", meshState: "mesh-ready" } as never;
    const primitiveModel = { objects: [object] } as never;
    const part = (id: string, owner: string) => ({
      part: { id, object_id: owner }, surfaceIndices: new Uint32Array([0, 1, 2]),
    });
    const signal = part("signal", "antenna_geom");
    const ground = part("ground", "antenna_geom");
    const other = part("other", "unrelated");
    const topologyModel = { positions: new Float32Array(9), magneticParts: [signal, ground, other] } as never;
    for (const committed of [[], [signal], [signal, ground], []]) {
      const ids = resolveViewport3DRealizedTopologyObjectIds({
        enabled: true, committedParts: new Set(committed) as never, primitiveModel,
        topologyModel, topologyFreshness: "current",
      });
      const ready = committed.length === 2;
      expect(shouldRenderPrimitiveObject(object, DEFAULT_OBJECT_VISUALIZATION, ids.has("antenna"), true)).toBe(!ready);
      expect(shouldRenderPrimitiveObject(object, DEFAULT_OBJECT_VISUALIZATION, ids.has("antenna"))).toBe(false);
      const markup = renderToStaticMarkup(
        <TopologyMeshLayer
          colors={{} as never} fieldModel={null}
          getPartSettings={() => DEFAULT_OBJECT_VISUALIZATION}
          materialProfile={{} as never} magnetizationTexturePreviews={new Map()}
          meshQualityColors={null} meshQualityOverlayVisible={false}
          onSelectPart={() => undefined} primitiveModel={primitiveModel}
          replacementObjectIds={ids} topologyFreshness="current" topologyModel={topologyModel}
          tracker={new Viewport3DResourceTracker()} vectorColorMode="orientation" vectorScale={1} vectorStyle={{}}
        />,
      );
      expect(markup).toContain('data-part-id="signal" data-render-visible="' + String(ready) + '"');
      expect(markup).toContain('data-part-id="ground" data-render-visible="' + String(ready) + '"');
      expect(markup).toContain('data-part-id="other" data-render-visible="true"');
    }
  });


  it("lets the authored texture own the solid while preserving the FEM wireframe", () => {
    const part = (id: string, objectId: string) => ({
      part: { id, object_id: objectId },
      surfaceIndices: new Uint32Array([0, 1, 2]),
    });
    const topologyModel = {
      positions: new Float32Array(9),
      magneticParts: [part("part:disk", "disk_geom"), part("part:other", "other")],
    } as never;
    const primitiveModel = {
      objects: [{ objectId: "disk", role: "magnet" }],
    } as never;
    for (const authoredTextureSurfaceObjectIds of [undefined, new Set(["disk"])]) {
      const markup = renderToStaticMarkup(
        <TopologyMeshLayer
          authoredTextureSurfaceObjectIds={authoredTextureSurfaceObjectIds}
          colors={{} as never}
          fieldModel={null}
          getPartSettings={() => ({
            ...DEFAULT_OBJECT_VISUALIZATION,
            visible: true,
            shaderVisible: true,
            wireframeVisible: true,
            surfaceColorSource: "orientation",
            activeQuantityId: "m",
          })}
          materialProfile={{} as never}
          magnetizationTexturePreviews={new Map()}
          meshQualityColors={null}
          meshQualityOverlayVisible={false}
          onSelectPart={() => undefined}
          primitiveModel={primitiveModel}
          topologyFreshness="current"
          topologyModel={topologyModel}
          tracker={new Viewport3DResourceTracker()}
          vectorColorMode="orientation"
          vectorScale={1}
          vectorStyle={{}}
        />,
      );
      expect(markup).toContain(
        'data-part-id="part:disk" data-render-visible="true" data-wireframe-visible="true" ' +
          'data-shader-visible="' + String(authoredTextureSurfaceObjectIds === undefined) + '"',
      );
      expect(markup).toContain(
        'data-part-id="part:other" data-render-visible="true" data-wireframe-visible="true" data-shader-visible="true"',
      );
    }
  });

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
