import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import { FallbackTopologyMeshLayer } from "./FallbackTopologyMeshLayer";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";

vi.mock("../viewport3dBatchedInvalidate", () => ({
  useBatchedInvalidate: () => () => undefined,
}));

const colors = {
  accent: "#aaccff",
  background: "#000000",
  field: "#ffffff",
  mesh: "#dddddd",
  selection: "#ffff00",
  wire: "#999999",
};

function fallbackTopology(): Viewport3DTopologyRenderModel {
  return {
    airboxParts: [],
    fallbackSurfaceIndices: new Uint32Array(),
    fallbackVolumeEdgeIndices: new Uint32Array(),
    magneticParts: [],
    meshGenerationId: null,
    meshRevision: null,
    nodeCount: 2,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
  };
}

function vectorFieldModel(): Viewport3DFieldRenderModel {
  return {
    complexFieldVector: null,
    fullVectorSegments: new Float32Array([0, 0, 0, 1, 0, 0, 1]),
    partVectorSegments: new Map(),
    scalarColors: null,
    scalarColorsByPartAndMode: new Map(),
    scalarColorsByMode: new Map(),
    visualizationPhaseRad: null,
  };
}

describe("FallbackTopologyMeshLayer", () => {
  it("does not build unused normals for unlit fallback surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("<meshBasicMaterial");
    expect(source).not.toContain("computeVertexNormals");
  });

  it("renders vector-only fallback topology layers", () => {
    const tracker = new Viewport3DResourceTracker();
    const markup = renderToStaticMarkup(
      <FallbackTopologyMeshLayer
        colors={colors}
        fallbackSettings={{
          ...DEFAULT_OBJECT_VISUALIZATION,
          boundsVisible: false,
          pointsVisible: false,
          shaderVisible: false,
          vectorsVisible: true,
          visible: true,
          wireframeVisible: false,
        }}
        femDomain={{
          airboxParts: [],
          magneticParts: [],
          magneticSurfacePartsByPartId: new Map(),
          objectPartIds: new Map(),
          partsById: new Map(),
        }}
        fieldModel={vectorFieldModel()}
        materialProfile={resolveViewport3DMaterialProfile(
          getViewport3DVisualProfile("interactive"),
        )}
        meshQualityColors={null}
        onSelectDomain={() => undefined}
        onSelectPart={() => undefined}
        topologyModel={fallbackTopology()}
        tracker={tracker}
        vectorColorMode="orientation"
        vectorStyle={{}}
      />,
    );

    expect(markup).toContain("instancedMesh");
  });
});
