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

vi.mock("./VectorFieldLayer", () => ({
  VectorFieldLayer: () => "instancedMesh",
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
    fallbackSurfaceEdgeIndices: null,
    fallbackSurfaceIndices: new Uint32Array(),
    fallbackSurfaceNodeIndices: new Uint32Array(),
    fallbackVolumeEdgeIndices: new Uint32Array(),
    magneticParts: [],
    meshGenerationId: null,
    meshRevision: null,
    meshTopologyHash: null,
    nodeCount: 2,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
  };
}

function vectorFieldModel(): Viewport3DFieldRenderModel {
  return {
    complexFieldVector: null,
    derivedWorkItems: [],
    fullVectorBuild: null,
    fullVectorSegments: new Float32Array([0, 0, 0, 1, 0, 0, 1]),
    partVectorBuilds: new Map(),
    partVectorSegments: new Map(),
    scalarColors: null,
    scalarColorsByPartAndMode: new Map(),
    scalarColorsByMode: new Map(),
    targetDiagnostics: [],
    targetPasses: new Map(),
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

  it("lets diagnostics bypass fallback field-color buffer application", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("viewport3DFieldColorLayersEnabledFromBrowserConfig");
    expect(source).toContain("fieldColorLayersEnabled");
    expect(source).toContain("useViewport3DScalarShaderColorUpload");
    expect(source).toContain("field-scalar-shader");
    expect(source).not.toContain("applyScalarShaderColorBuffer");
  });

  it("does not build fallback point geometry when points are hidden", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("if (!renderSettings.pointsVisible) return null;");
  });

  it("routes fallback topology geometry adoption through the upload manager", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("useViewport3DGeometryUpload");
    expect(source).toContain("createViewport3DGpuUploadManager");
    expect(source).toContain('lane: "topology-index"');
    expect(source).not.toContain("const geometry = useMemo");
    expect(source).not.toContain("const edgeGeometry = useMemo");
    expect(source).not.toContain("const pointGeometry = useMemo");
  });

  it("delegates fallback primitive rendering out of the upload orchestration component", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("function FallbackTopologyMeshPrimitives");
    expect(source).toContain("<FallbackTopologyMeshPrimitives");
  });

  it("resolves fallback field buffers through the target-pass contract", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("resolveViewport3DTargetSurfaceLayerInput");
    expect(source).toContain("resolveViewport3DTargetVectorLayerInput");
    expect(source).not.toContain(
      "fieldModel?.scalarColorsByMode.get(scalarColorMode)",
    );
    expect(source).not.toContain("fieldModel?.fullVectorBuild ?? null");
    expect(source).not.toContain("fieldModel?.fullVectorSegments ?? null");
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
