import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OBJECT_VISUALIZATION,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  createMeshPartSurfaceGeometry,
  resolveMeshPartSurfacePickIdentity,
  resolveMeshPartBoundaryFaceIndexForPick,
  resolveMeshPartVisibleScalarColorState,
  resolveRetainedMeshPartScalarColors,
  resolveMeshPartScalarColors,
  resolveMeshPartVectorLayerInput,
  resolveMeshPartWireframeEdgeIndices,
  resolveMeshPartPointNodeSelection,
  recordMeshPartSurfaceAdoption,
} from "./MeshPartLayer";
import {
  buildMeshPartScalarColorRetentionKey,
  resolveMeshPartCommittedScalarColorState,
} from "./meshPartScalarTransition";
import {
  buildMeshPartSurfaceGeometryUploadKey,
  resolveMeshPartSurfaceGeometryProjection,
} from "./meshPartGeometryPlan";
import { createViewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import { resolveViewport3DScalarColorBufferKey } from "../viewport3dFieldMapping";

describe("MeshPartLayer", () => {
  it("maps both render triangles of a quad back to the same global facet", () => {
    const part = {
      boundary_face_count: 2,
      boundary_face_start: 7,
    };
    const mapping = new Uint32Array([7, 8, 8]);

    expect(resolveMeshPartBoundaryFaceIndexForPick({
      expandedSurfaceFaces: false,
      faceIndex: 1,
      part,
      surfaceTriangleFacetIndices: mapping,
    })).toBe(8);
    expect(resolveMeshPartBoundaryFaceIndexForPick({
      expandedSurfaceFaces: false,
      faceIndex: 2,
      part,
      surfaceTriangleFacetIndices: mapping,
    })).toBe(8);
  });

  it("resolves canonical cell identity only for actual surface hits", () => {
    const surfacePick = resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: 1,
      part: {
        boundary_face_count: 1,
        boundary_face_indices: [13],
        boundary_face_start: 13,
      },
      surfaceHit: true,
      surfaceTriangleCellTypes: new Uint32Array([2, 3]),
      surfaceTriangleFacetIndices: new Uint32Array([13, 13]),
      surfaceTriangleGlobalCellOrdinals: new BigUint64Array([
        BigInt(7),
        BigInt("9007199254740993"),
      ]),
    });
    expect(surfacePick).toEqual({
      boundaryFaceIndex: 13,
      elementFamily: "pyramid5",
      globalCellOrdinal: "9007199254740993",
    });

    expect(resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: 1,
      part: {
        boundary_face_count: 1,
        boundary_face_indices: [13],
        boundary_face_start: 13,
      },
      surfaceHit: false,
      surfaceTriangleCellTypes: new Uint32Array([2, 3]),
      surfaceTriangleFacetIndices: new Uint32Array([13, 13]),
      surfaceTriangleGlobalCellOrdinals: new BigUint64Array([BigInt(7), BigInt(8)]),
    })).toEqual({
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    });
  });

  it("fails closed for unresolved or misaligned surface cell mappings", () => {
    expect(resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: 0,
      part: {
        boundary_face_count: 1,
        boundary_face_start: 3,
      },
      surfaceHit: true,
      surfaceTriangleCellTypes: new Uint32Array([0]),
      surfaceTriangleFacetIndices: new Uint32Array([3]),
      surfaceTriangleGlobalCellOrdinals: new BigUint64Array([BigInt(0)]),
    })).toEqual({
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    });

    expect(resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: 0,
      part: {
        boundary_face_count: 2,
        boundary_face_start: 3,
      },
      surfaceHit: true,
      surfaceTriangleCellTypes: new Uint32Array([2, 2]),
      surfaceTriangleFacetIndices: new Uint32Array([3, 4]),
      surfaceTriangleGlobalCellOrdinals: new BigUint64Array([BigInt(9)]),
    })).toEqual({
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    });
  });

  it.each([
    ["facet only", new Uint32Array([3]), undefined, undefined],
    ["type only", undefined, new Uint32Array([2]), undefined],
    ["ordinal only", undefined, undefined, new BigUint64Array([BigInt(9)])],
    ["facet and type", new Uint32Array([3]), new Uint32Array([2]), undefined],
  ])("fails closed for a partial %s identity map", (
    _variant,
    surfaceTriangleFacetIndices,
    surfaceTriangleCellTypes,
    surfaceTriangleGlobalCellOrdinals,
  ) => {
    expect(resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: 0,
      part: {
        boundary_face_count: 1,
        boundary_face_start: 3,
      },
      surfaceHit: true,
      surfaceTriangleCellTypes,
      surfaceTriangleFacetIndices,
      surfaceTriangleGlobalCellOrdinals,
    })).toEqual({
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    });
  });

  it("keeps the boundary-only legacy pick when all identity maps are absent", () => {
    expect(resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: 0,
      part: {
        boundary_face_count: 1,
        boundary_face_start: 3,
      },
      surfaceHit: true,
    })).toEqual({
      boundaryFaceIndex: 3,
      elementFamily: null,
      globalCellOrdinal: null,
    });
  });
  it("changes scalar upload retention identity when the requested field appearance changes", () => {
    const key = ({
      mode = "orientation",
      palette = "viridis",
      quantityId = "m",
    }: {
      mode?: string;
      palette?: string;
      quantityId?: string;
    } = {}) =>
      buildMeshPartScalarColorRetentionKey({
        mode,
        partId: "part:film",
        projection: "indexed",
        quantityId,
        scalarColorPalette: palette,
        topologyRevision: 7,
        vertexCount: 12,
      });

    const initial = key();
    expect(key({ mode: "x" })).not.toBe(initial);
    expect(key({ palette: "magma" })).not.toBe(initial);
    expect(key({ quantityId: "H_eff" })).not.toBe(initial);
  });

  it("does not retain a previous field texture while another quantity or component is loading", () => {
    const previous = {
      colorMode: "x",
      colorPalette: "viridis",
      colors: new Float32Array(12),
      quantityId: "m",
      range: { max: 1, min: -1 },
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous,
        scalarColorMode: "y",
        settings: {
          ...DEFAULT_OBJECT_VISUALIZATION,
          activeQuantityId: "H_demag",
          scalarColorPalette: "viridis",
          surfaceProjectionMode: "raw_nodal",
        },
        topologyRevision: 7,
        vertexCount: 4,
      }),
    ).toBeNull();
  });

  it("keeps the committed shader visible while requested vertex colors are pending", () => {
    const committedShader = {
      colors: new Float32Array(0),
      colorMode: "orientation",
      range: { max: 1, min: 0 },
      vectorValues: new Float32Array(6),
    };

    expect(
      resolveMeshPartCommittedScalarColorState({
        requestedPipeline: "vertex",
        visibleShaderColors: committedShader,
        visibleVertexColors: null,
      }),
    ).toEqual({ buffer: committedShader, pipeline: "shader" });
  });

  it("keeps committed vertex colors visible while a requested shader is pending", () => {
    const committedVertex = {
      colors: new Float32Array(6),
      colorMode: "orientation",
      range: { max: 1, min: 0 },
    };

    expect(
      resolveMeshPartCommittedScalarColorState({
        requestedPipeline: "shader",
        visibleShaderColors: null,
        visibleVertexColors: committedVertex,
      }),
    ).toEqual({ buffer: committedVertex, pipeline: "vertex" });
  });

  it("keeps geometry upload identity stable across quantity, component, and colormap changes", () => {
    const geometryKey = (patch: Partial<VisualizationTargetSettings>) =>
      buildMeshPartSurfaceGeometryUploadKey({
        indicesByteLength: 96,
        partId: "part:film",
        positionsByteLength: 384,
        projection: resolveMeshPartSurfaceGeometryProjection({
          ...DEFAULT_OBJECT_VISUALIZATION,
          surfaceColorSource: "component_x",
          ...patch,
        }),
        topologyRevision: 7,
      });
    const initial = geometryKey({});

    expect(geometryKey({ activeQuantityId: "H_eff" })).toBe(initial);
    expect(geometryKey({ surfaceColorSource: "component_y" })).toBe(initial);
    expect(geometryKey({ scalarColorPalette: "magma" })).toBe(initial);
  });

  it("uses the effective full node selection for the points pass", () => {
    const fullNodeSelection = { nodeIndices: [4, 5, 6] };
    expect(
      resolveMeshPartPointNodeSelection("full", {
        fullNodeSelection,
        part: { node_indices: [0, 1, 2, 3, 4, 5, 6] },
        surfaceNodeSelection: { nodeIndices: [4, 5] },
      } as never),
    ).toBe(fullNodeSelection);
  });

  it("keeps Surface points empty while canonical surface membership is unavailable", () => {
    expect(
      resolveMeshPartPointNodeSelection("surface", {
        fullNodeSelection: { nodeIndices: [4, 5, 6] },
        part: { node_indices: [0, 1, 2, 3, 4, 5, 6] },
        surfaceNodeSelection: null,
      } as never),
    ).toEqual({ nodeIndices: [] });
  });
  it("records the actually visible retained scalar buffer, not merely the requested candidate", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["part:a", ["object:a"]]]));
    registry.retainDemand("object:a");

    recordMeshPartSurfaceAdoption({
      carrierId: "part:a",
      fieldBufferId: "field-requested-new",
      registry,
      sessionIdentity: { sessionEpoch: "test-session@1000", sessionId: "test-session" },
      scalarBuffer: {
        buildKey: "scalar-retained",
        colors: new Float32Array(9),
        range: { max: 1, min: 0 },
        sourceFieldBufferId: "field-retained-old",
        sourceResourceKey: "resource-retained-old",
      },
    });

    expect(registry.snapshot("object:a")[0]).toMatchObject({
      fieldBufferId: "field-retained-old",
      resourceKey: "resource-retained-old",
      scalarBufferKey: "scalar-retained",
    });
  });
  it("records a canonical scalar key when synchronous colors have no build key", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["part:a", ["object:a"]]]));
    registry.retainDemand("object:a");
    const scalarBuffer = {
      colors: new Float32Array(6),
      colorMode: "x",
      quantityId: "H_demag",
      range: { max: 1, min: 0 },
    };

    recordMeshPartSurfaceAdoption({
      carrierId: "part:a",
      fieldBufferId: "field-a",
      registry,
      sessionIdentity: { sessionEpoch: "test-session@1000", sessionId: "test-session" },
      scalarBuffer,
    });

    expect(registry.snapshot("object:a")[0]?.scalarBufferKey).toBe(
      resolveViewport3DScalarColorBufferKey(scalarBuffer),
    );
  });
  it("clears only its exact surface receipt when the adopted buffer is hidden or unmounted", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("adoptionRegistry.clearAdoption(adoptionOwnerId, adoption)");
    expect(source).toContain("unregister();");
  });
  it("uses the scalar shader material when large scalar buffers skip CPU RGB colors", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("canApplyScalarShaderColorBuffer");
    expect(source).toContain("useViewport3DScalarShaderColorUpload");
    expect(source).toContain("field-scalar-shader");
    expect(source).toContain("<primitive attach=\"material\" object={scalarShaderMaterial} />");
    expect(source).not.toContain("applyScalarShaderColorBuffer");
  });

  it("lets diagnostics bypass field-color buffer application without hiding surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("viewport3DFieldColorLayersEnabledFromBrowserConfig");
    expect(source).toContain("fieldColorLayersEnabled");
    expect(source).toContain("useViewport3DScalarShaderColorUpload");
    expect(source).toContain("field-scalar-shader");
    expect(source).not.toContain("applyScalarShaderColorBuffer");
  });

  it("uses unlit materials for mesh part fallback surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("<meshBasicMaterial");
    expect(source).not.toContain("<meshStandardMaterial");
    expect(source).not.toContain("MeshStandardMaterial");
    expect(source).not.toContain("computeVertexNormals");
  });

  it("does not render depth-bypassing hidden edges for magnetic-object wireframe", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain(
      "materialPolicyProps(\"hiddenEdges\")",
    );
    expect(source).not.toContain(
      "RENDER_POLICIES.hiddenEdges.renderOrder",
    );
  });

  it("does not require surface geometry before rendering mesh-backed subpasses", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "if (!renderSettings.visible || !hasAnyVisibleRenderableSubLayer) return null;",
    );
    expect(source).not.toContain(
      "if (!geometry || !renderSettings.visible",
    );
  });

  it("does not build point geometry when mesh-backed points are hidden", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("if (!renderSettings.pointsVisible) return null;");
  });

  it("routes mesh part topology geometry adoption through the GPU upload manager", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );
    const componentSource = source.slice(
      source.indexOf("export const MeshPartLayer"),
    );

    expect(source).toContain("useViewport3DGeometryUpload");
    expect(source).toContain('lane: "topology-index"');
    expect(componentSource).not.toContain("const geometry = useMemo");
    expect(componentSource).not.toContain("const edgeGeometry = useMemo");
    expect(componentSource).not.toContain("const pointGeometry = useMemo");
  });

  it("builds unindexed face-expanded geometry for surface face projection", () => {
    const geometry = createMeshPartSurfaceGeometry({
      expandSurfaceFaces: true,
      positions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      surfaceIndices: Uint32Array.from([0, 1, 2]),
    });

    expect(geometry?.index).toBeNull();
    expect(geometry?.getAttribute("position").count).toBe(3);
    expect(Array.from(geometry?.getAttribute("position").array ?? [])).toEqual([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
  });

  it("expands surface geometry for every projected surface mode", () => {
    expect(
      resolveMeshPartSurfaceGeometryProjection({
        surfaceColorSource: "component_x",
        surfaceProjectionMode: "surface_faces",
      }),
    ).toBe("surface_faces");
    expect(
      resolveMeshPartSurfaceGeometryProjection({
        surfaceColorSource: "component_x",
        surfaceProjectionMode: "thickness_average_z",
      }),
    ).toBe("thickness_average_z");
    expect(
      resolveMeshPartSurfaceGeometryProjection({
        surfaceColorSource: "component_x",
        surfaceProjectionMode: "raw_nodal",
      }),
    ).toBe("indexed");
  });

  it("requires positional facet mapping for face-expanded picks", () => {
    expect(
      resolveMeshPartBoundaryFaceIndexForPick({
        expandedSurfaceFaces: true,
        faceIndex: 2,
        part: {
          boundary_face_count: 2,
          boundary_face_start: 7,
        },
      }),
    ).toBeNull();
    expect(
      resolveMeshPartBoundaryFaceIndexForPick({
        expandedSurfaceFaces: true,
        faceIndex: 1,
        part: {
          boundary_face_count: 2,
          boundary_face_indices: [11, 13],
          boundary_face_start: 7,
        },
        surfaceTriangleFacetIndices: new Uint32Array([11, 13, 13]),
      }),
    ).toBe(13);
  });

  it("keeps previous uploaded geometry visible while replacement topology uploads", () => {
    const uploadSource = readFileSync(
      fileURLToPath(new URL("../hooks/useViewport3DGeometryUpload.ts", import.meta.url)),
      "utf8",
    );
    const uploadEffect = uploadSource.slice(
      uploadSource.indexOf("useEffect(() => {"),
      uploadSource.indexOf("const abortController = new AbortController();"),
    );

    expect(uploadEffect).toContain("if (!enabled) {");
    expect(uploadEffect).toContain("clearCurrentGeometry();");
    expect(uploadSource).toContain("if (store.getSnapshot().geometry !== uploadedGeometry)");
    expect(uploadSource).not.toContain("if (store.getSnapshot().geometry === uploadedGeometry)");
    expect(uploadSource).toContain("try {\n              store.publish(previousGeometry);\n            } finally {\n              releaseGeometry(uploadedGeometry);");
    expect(uploadEffect).not.toContain("useEffect(() => {\n    store.publish(null);");
  });

  it("keys scalar color upload retention by stable carrier semantics", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("const scalarColorRetentionKey = useMemo");
    expect(source).toContain("buildMeshPartScalarColorRetentionKey({");
    expect(source).toContain("partId: part.id");
    expect(source).toContain("mode: scalarColorMode");
    expect(source).toContain("quantityId: renderSettings.activeQuantityId");
    expect(source).toContain("retentionKey: scalarColorRetentionKey");
  });

  it("routes mesh vector layer input through target-pass selection", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("resolveViewport3DTargetVectorLayerInput");
    expect(source).toContain("vectorLayerInput.buildReference");
    expect(source).toContain("vectorLayerInput.segments");
    expect(source).not.toContain("fieldModel?.partVectorBuilds.get(part.id)");
    expect(source).not.toContain("fieldModel?.partVectorSegments.get(part.id)");
  });

  it("uses volume edges for full magnetic-object wireframe and surface edges for surface mode", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const volumeEdges = new Uint32Array([0, 1, 1, 2, 2, 3, 0, 3]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: volumeEdges,
    };

    expect(resolveMeshPartWireframeEdgeIndices("full", partModel)).toBe(
      volumeEdges,
    );
    expect(resolveMeshPartWireframeEdgeIndices("surface", partModel)).toBe(
      surfaceEdges,
    );
  });

  it("does not touch edge buffers when magnetic-object wireframe is hidden", () => {
    const partModel = {
      get edgeIndices(): Uint32Array {
        throw new Error("surface edges should not be read");
      },
      get volumeEdgeIndices(): Uint32Array {
        throw new Error("volume edges should not be read");
      },
    };

    expect(
      resolveMeshPartWireframeEdgeIndices("full", partModel, false),
    ).toBeNull();
    expect(
      resolveMeshPartWireframeEdgeIndices("surface", partModel, false),
    ).toBeNull();
  });

  it("does not silently downgrade full magnetic-object wireframe to surface edges when volume edges are unavailable", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: null,
    };

    expect(resolveMeshPartWireframeEdgeIndices("full", partModel)).toBeNull();
    expect(resolveMeshPartWireframeEdgeIndices("surface", partModel)).toBe(
      surfaceEdges,
    );
  });

  it("does not reuse a global scalar color buffer for a different object quantity", () => {
    const globalMagnetizationY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };
    const partEffectiveFieldY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "H_eff",
      range: { max: 5, min: -5 },
    };
    const fieldModel = {
      scalarColorsByMode: new Map([["y", globalMagnetizationY]]),
      scalarColorsByPartAndMode: new Map<string, Map<string, typeof partEffectiveFieldY>>(),
    };

    expect(
      resolveMeshPartScalarColors({
        fieldModel,
        partId: "part-a",
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
      }),
    ).toBeNull();

    fieldModel.scalarColorsByPartAndMode.set(
      "part-a",
      new Map([["y", partEffectiveFieldY]]),
    );

    expect(
      resolveMeshPartScalarColors({
        fieldModel,
        partId: "part-a",
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
      }),
    ).toBe(partEffectiveFieldY);
  });

  it("uses target-pass scalar colors before legacy part/global maps", () => {
    const globalMagnetizationY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };
    const targetEffectiveFieldY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "H_eff",
      range: { max: 5, min: -5 },
    };

    expect(
      resolveMeshPartScalarColors({
        fieldModel: {
          scalarColorsByMode: new Map([["y", globalMagnetizationY]]),
          scalarColorsByPartAndMode: new Map(),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  passId: "test:surface",
degradation: null,
                  scalarColorMode: "y",
                  scalarColors: targetEffectiveFieldY,
                },
                vectors: {
                  passId: "test:vector-glyph",
buildReference: null,
                  degradation: null,
                  segments: null,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
      }),
    ).toBe(targetEffectiveFieldY);
  });

  it("keeps uploaded vertex colors visible while the next projection buffer uploads", () => {
    const previousProjectionColors = {
      colors: new Float32Array(9),
      colorMode: "x",
      colorPalette: "viridis",
      projectionMode: "surface_faces" as const,
      quantityId: "m",
      range: { max: 1, min: -1 },
    };
    const nextProjectionColors = {
      ...previousProjectionColors,
      colors: new Float32Array(9).fill(0.25),
      targetRevision: "field=next",
    };

    expect(
      resolveMeshPartVisibleScalarColorState({
        effectiveScalarColors: nextProjectionColors,
        meshQualityColors: null,
        surfaceVertexCount: 3,
        vertexColorsEnabled: true,
        visibleScalarColors: previousProjectionColors,
      }),
    ).toEqual({
      canUseVertexScalarColors: true,
      hasScalarColors: true,
    });
  });

  it("does not fall back to global colors when target-pass surface rejects the mode", () => {
    const globalMagnetizationY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };

    expect(
      resolveMeshPartScalarColors({
        fieldModel: {
          scalarColorsByMode: new Map([["y", globalMagnetizationY]]),
          scalarColorsByPartAndMode: new Map(),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  passId: "test:surface",
degradation: "sampled-buffer-not-surface-capable",
                  scalarColorMode: "y",
                  scalarColors: null,
                },
                vectors: {
                  passId: "test:vector-glyph",
buildReference: null,
                  degradation: null,
                  segments: null,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "m",
          scalarColorPalette: "viridis",
        },
      }),
    ).toBeNull();
  });

  it("does not fall back to global colors when target-pass surface has a different mode", () => {
    const globalMagnetizationY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };
    const targetOrientation = {
      colors: new Float32Array(0),
      colorMode: "orientation",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: 0 },
      vectorValues: new Float32Array(6),
    };

    expect(
      resolveMeshPartScalarColors({
        fieldModel: {
          scalarColorsByMode: new Map([["y", globalMagnetizationY]]),
          scalarColorsByPartAndMode: new Map(),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  passId: "test:surface",
degradation: null,
                  scalarColorMode: "orientation",
                  scalarColors: targetOrientation,
                },
                vectors: {
                  passId: "test:vector-glyph",
buildReference: null,
                  degradation: null,
                  segments: null,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "m",
          scalarColorPalette: "viridis",
        },
      }),
    ).toBeNull();
  });

  it("uses target-pass vector segments before legacy part vector maps", () => {
    const legacySegments = new Float32Array([0, 0, 0, 1, 0, 0]);
    const targetSegments = new Float32Array([0, 0, 0, 0, 1, 0]);
    const legacyBuild = {
      buildKey: "legacy",
      fieldRevision: "r1",
      groupKey: "legacy",
      revisionSummary: "legacy",
      targetRevision: "legacy-target",
      topologyRevision: "legacy-topology",
    };
    const targetBuild = {
      buildKey: "target",
      fieldRevision: "r2",
      groupKey: "target",
      revisionSummary: "target",
      targetRevision: "target-target",
      topologyRevision: "target-topology",
    };

    expect(
      resolveMeshPartVectorLayerInput({
        fieldModel: {
          partVectorBuilds: new Map([["part-a", legacyBuild]]),
          partVectorSegments: new Map([["part-a", legacySegments]]),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  passId: "test:surface",
degradation: null,
                  scalarColorMode: null,
                  scalarColors: null,
                },
                vectors: {
                  passId: "test:vector-glyph",
buildReference: targetBuild,
                  degradation: null,
                  segments: targetSegments,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
      }),
    ).toEqual({
      buildReference: targetBuild,
      segments: targetSegments,
    });
  });

  it("does not fall back to legacy vector maps when target-pass vectors are rejected", () => {
    const legacySegments = new Float32Array([0, 0, 0, 1, 0, 0]);
    const legacyBuild = {
      buildKey: "legacy",
      fieldRevision: "r1",
      groupKey: "legacy",
      revisionSummary: "legacy",
      targetRevision: "legacy-target",
      topologyRevision: "legacy-topology",
    };

    expect(
      resolveMeshPartVectorLayerInput({
        fieldModel: {
          partVectorBuilds: new Map([["part-a", legacyBuild]]),
          partVectorSegments: new Map([["part-a", legacySegments]]),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  passId: "test:surface",
degradation: null,
                  scalarColorMode: null,
                  scalarColors: null,
                },
                vectors: {
                  passId: "test:vector-glyph",
buildReference: null,
                  degradation: "scalar-buffer-not-vector-capable",
                  segments: null,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
      }),
    ).toEqual({
      buildReference: null,
      segments: null,
    });
  });

  it("does not retain a scalar texture while a different color mode is building", () => {
    const previousOrientation = {
      colors: new Float32Array(0),
      colorMode: "orientation",
      colorPalette: "viridis",
      quantityId: "H_eff",
      range: { max: 1, min: 0 },
      vectorValues: new Float32Array(6),
    };
    const replacementY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "H_eff",
      range: { max: 5, min: -5 },
      scalarValues: new Float32Array(2),
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousOrientation,
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
        vertexCount: 2,
      }),
    ).toBeNull();
    expect(
      resolveRetainedMeshPartScalarColors({
        current: replacementY,
        previous: previousOrientation,
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
        vertexCount: 2,
      }),
    ).toBe(replacementY);
  });

  it("does not retain a scalar texture while a different quantity is pending", () => {
    const previousMagnetizationY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
      scalarValues: new Float32Array(2),
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousMagnetizationY,
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
        vertexCount: 2,
      }),
    ).toBeNull();
  });

  it("retains the last same-mode scalar texture while replacement data is building", () => {
    const previousY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "H_eff",
      range: { max: 1, min: -1 },
      scalarValues: new Float32Array(2),
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousY,
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
        vertexCount: 2,
      }),
    ).toBe(previousY);
  });

  it("does not retain scalar textures across topology revision changes", () => {
    const previousY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "H_eff",
      range: { max: 1, min: -1 },
      scalarValues: new Float32Array(2),
      topologyRevision: "mesh-a",
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousY,
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
        topologyRevision: "mesh-b",
        vertexCount: 2,
      }),
    ).toBeNull();
  });

  it("does not retain face-expanded scalar textures after switching projection mode", () => {
    const previousSurfaceFaces = {
      colors: new Float32Array(9),
      colorMode: "x",
      colorPalette: "viridis",
      geometryRole: "face_expanded_surface" as const,
      projectionMode: "surface_faces" as const,
      quantityId: "m",
      range: { max: 1, min: -1 },
      scalarValues: new Float32Array(3),
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousSurfaceFaces,
        scalarColorMode: "x",
        settings: {
          activeQuantityId: "m",
          scalarColorPalette: "viridis",
          surfaceProjectionMode: "raw_nodal",
        },
        vertexCount: 3,
      }),
    ).toBeNull();
  });

  it("does not retain scalar textures across pending quantity changes or solid color", () => {
    const previousMagnetizationY = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
      scalarValues: new Float32Array(2),
    };

    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousMagnetizationY,
        scalarColorMode: "y",
        settings: {
          activeQuantityId: "H_eff",
          scalarColorPalette: "viridis",
        },
        vertexCount: 2,
      }),
    ).toBeNull();
    expect(
      resolveRetainedMeshPartScalarColors({
        current: null,
        previous: previousMagnetizationY,
        scalarColorMode: null,
        settings: {
          activeQuantityId: "m",
          scalarColorPalette: "viridis",
        },
        vertexCount: 2,
      }),
    ).toBeNull();
  });
});
