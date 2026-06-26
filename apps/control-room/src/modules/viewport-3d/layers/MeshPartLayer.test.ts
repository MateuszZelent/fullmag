import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  resolveRetainedMeshPartScalarColors,
  resolveMeshPartScalarColors,
  resolveMeshPartVectorLayerInput,
  resolveMeshPartWireframeEdgeIndices,
} from "./MeshPartLayer";

describe("MeshPartLayer", () => {
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

  it("does not suppress hidden full-volume wireframe behind a shaded magnetic surface", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "renderSettings.wireframeVisible && renderSettings.shaderVisible && edgeGeometry",
    );
    expect(source).not.toContain(
      'renderSettings.geometryScope !== "full" && edgeGeometry',
    );
  });

  it("uses target visibility as the master display gate for mesh-backed parts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "if (!geometry || !renderSettings.visible || !hasAnyVisibleSubLayer) return null;",
    );
    expect(source).not.toContain(
      "(!renderSettings.visible && !hasAnyVisibleSubLayer)",
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
    expect(uploadEffect).not.toContain("useEffect(() => {\n    store.publish(null);");
  });

  it("keys scalar color upload retention by per-part color semantics", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("const scalarColorRetentionKey = useMemo");
    expect(source).toContain("`part=${part.id}`");
    expect(source).toContain("`mode=${scalarColorMode}`");
    expect(source).toContain(
      "`quantity=${resolveCanonicalQuantityId(renderSettings.activeQuantityId)}`",
    );
    expect(source).toContain(
      "`palette=${renderSettings.scalarColorPalette ?? \"default\"}`",
    );
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

  it("retains the last compatible scalar texture while a different color mode is building", () => {
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
    ).toBe(previousOrientation);
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

  it("does not retain a stale scalar texture from a different quantity", () => {
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

  it("does not retain scalar textures across quantity or solid-color changes", () => {
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
