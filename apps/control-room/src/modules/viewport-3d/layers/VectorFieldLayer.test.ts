import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  BoxGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
} from "three";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

import {
  createVectorGlyphUploadKeys,
  ensureWhiteVertexColorAttribute,
  resolveVectorFieldLayerStyle,
  syncVectorGlyphMaterialStyle,
  syncVectorGlyphColorState,
} from "./VectorFieldLayer";

const vectorFieldLayerSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/layers/VectorFieldLayer.tsx"),
  "utf8",
);
import {
  shaderColorFromSettings,
  shaderUsesVertexColors,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

describe("VectorFieldLayer performance contracts", () => {
  it("keys glyph uploads by semantic build revision instead of buffer shape only", () => {
    expect(
      createVectorGlyphUploadKeys({
        buildKey: "vector-glyph:session=s1:topology=t1:field=f2",
        colorByteLength: 96,
        glyphCount: 8,
        targetRevision: "target-viz-7",
        transformByteLength: 1024,
      }),
    ).toEqual({
      colorKey:
        "vector-glyph-colors:vector-glyph:session=s1:topology=t1:field=f2:target=target-viz-7:count=8:bytes=96",
      matrixKey:
        "vector-glyph-matrices:vector-glyph:session=s1:topology=t1:field=f2:target=target-viz-7:count=8:bytes=1024",
      targetRevision: "target-viz-7",
    });
  });

  it("routes glyph matrix uploads through cancellable bounded batches", () => {
    expect(vectorFieldLayerSource).toContain(
      "const VECTOR_GLYPH_UPLOAD_BATCH_SIZE",
    );
    expect(vectorFieldLayerSource).toContain(
      "const VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS",
    );
    expect(vectorFieldLayerSource).toContain(
      "function buildVectorGlyphUploadBatches",
    );
    expect(vectorFieldLayerSource).toContain("createViewport3DGpuUploadManager");
    expect(vectorFieldLayerSource).toContain("uploadManager.enqueue");
    expect(vectorFieldLayerSource).toContain("onVisible:");
    expect(vectorFieldLayerSource).toContain(
      `onVisible: () => {
        activeShaft.count = activeGlyphs.count;
        activeHead.count = activeGlyphs.count;`,
    );
    expect(vectorFieldLayerSource).toContain("addUpdateRange");
    expect(vectorFieldLayerSource).toContain(
      "fullmag.viewport3d.buildVectorGlyphInstances",
    );
    expect(vectorFieldLayerSource).toContain(
      "fullmag.viewport3d.uploadVectorGlyphColors",
    );
    expect(vectorFieldLayerSource).toContain(
      "fullmag.viewport3d.uploadVectorGlyphMatrices",
    );
    expect(vectorFieldLayerSource).toContain("function useVectorGlyphBuild");
    expect(vectorFieldLayerSource).toContain(
      "buildViewport3DVectorGlyphsOffMainThread",
    );
    expect(vectorFieldLayerSource).toContain("vector-glyph-build");
    expect(vectorFieldLayerSource).not.toContain(
      "buildVectorGlyphInstances(segments",
    );
    expect(vectorFieldLayerSource).not.toContain(
      "buildVectorGlyphTransforms(segments",
    );
    expect(vectorFieldLayerSource).not.toContain(
      "buildVectorGlyphColors(segments",
    );
    expect(vectorFieldLayerSource).not.toContain(
      "for (let index = 0; index < glyphs.count; index += 1)",
    );
    expect(vectorFieldLayerSource).not.toContain(
      "function requestVectorGlyphUploadTask",
    );
    expect(vectorFieldLayerSource).not.toContain(
      "function cancelVectorGlyphUploadTask",
    );
    expect(vectorFieldLayerSource).not.toContain(
      `// Set visible count (may be less than capacity).
    activeShaft.count = activeGlyphs.count;
    activeHead.count = activeGlyphs.count;`,
    );
    expect(vectorFieldLayerSource).not.toContain("requestAnimationFrame");
    expect(vectorFieldLayerSource).not.toContain("setTimeout(callback, 0)");
  });

  it("keeps glyph builds asynchronous and uploads only resolved build buffers", () => {
    const buildHookStart = vectorFieldLayerSource.indexOf(
      "function useVectorGlyphBuild(",
    );
    const uploadHookStart = vectorFieldLayerSource.indexOf(
      "function useVectorGlyphUpload(",
    );
    expect(buildHookStart).toBeGreaterThanOrEqual(0);
    expect(uploadHookStart).toBeGreaterThan(buildHookStart);

    const buildHookSource = vectorFieldLayerSource.slice(
      buildHookStart,
      uploadHookStart,
    );
    expect(buildHookSource).toContain(
      "buildViewport3DVectorGlyphsOffMainThread",
    );
    expect(buildHookSource).toContain("buildKey:");
    expect(buildHookSource).toContain("groupKey:");
    expect(buildHookSource).toContain("latestWins: true");
    expect(buildHookSource).toContain("createVectorGlyphBuildStore");
    expect(buildHookSource).toContain("snapshot.buildKey === buildKey");
    expect(buildHookSource).toContain("useSyncExternalStore");
    expect(buildHookSource).toContain("AbortController");
    expect(buildHookSource).toContain("createViewport3DDerivedBufferCache");
    expect(buildHookSource).toContain("resolveVisible");
    expect(buildHookSource).toContain("retainedBuildRef");
    expect(buildHookSource).toContain("cache.tryRetain(visibleCacheKey)");
    expect(buildHookSource).toContain(
      "if (!retainedVisibleBuild) return undefined;",
    );
    expect(buildHookSource).toContain("cache.evictStaleRevisions");
    expect(buildHookSource).toContain("retainedBuildRef.current.release()");
    expect(buildHookSource).toContain("stale-compatible");
    expect(buildHookSource).toContain("stale-physical");
    expect(buildHookSource).not.toContain("useState<VectorGlyphBuildResult");
    expect(vectorFieldLayerSource).not.toContain(
      "const glyphTransforms = useMemo(",
    );
    expect(vectorFieldLayerSource).not.toContain("const glyphColors = useMemo(");
    expect(vectorFieldLayerSource).toContain("createVectorGlyphUploadKeys");
    expect(vectorFieldLayerSource).toContain(
      "targetRevision: uploadKeys?.targetRevision ?? null",
    );
    expect(vectorFieldLayerSource).toContain("buildKey: vectorGlyphBuildKey");
  });
});

describe("VectorFieldLayer style mapping", () => {
  it("maps canonical vector style into material alpha, monochrome color, and glyph thickness", () => {
    expect(
      resolveVectorFieldLayerStyle({
        colorMode: "monochrome",
        fallbackColor: "#55ccff",
        opacity: 0.5,
        style: {
          alpha: 0.4,
          monoColor: "#ff3366",
          thickness: 2,
        },
      }),
    ).toEqual({
      headRadiusRatio: 0.40,
      materialColor: "#ff3366",
      materialOpacity: 0.2,
      shaftRadiusRatio: 0.16,
    });
  });

  it("applies glyph material profile opacity to vector style", () => {
    expect(
      resolveVectorFieldLayerStyle({
        colorMode: "monochrome",
        fallbackColor: "#55ccff",
        opacity: 0.5 * 0.8,
        style: {
          alpha: 0.5,
          monoColor: "#ff3366",
          thickness: 1,
        },
      }).materialOpacity,
    ).toBe(0.2);
  });

  it("maps target display settings into shader wireframe and vector layer styles", () => {
    const settings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      opacityPercent: 50,
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ff3366",
      surfaceColorSource: "solid",
      vectorAlphaPercent: 40,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 2,
      wireframeOpacityPercent: 30,
    } as const;

    expect(shaderColorFromSettings(settings, "#dddddd")).toBe("#ff3366");
    expect(shaderUsesVertexColors(settings)).toBe(false);
    expect(surfaceScalarColorModeFromSettings(settings)).toBeNull();
    expect(wireframeOpacityFromSettings(settings)).toBe(0.15);
    expect(
      wireframeOpacityFromSettings(settings, { opacity: 0.42 }),
    ).toBe(0.063);
    expect(vectorColorModeFromSettings(settings, "orientation")).toBe("x");
    expect(vectorStyleFromSettings(settings, {})).toEqual({
      alpha: 0.4,
      monoColor: "#44ccff",
      thickness: 2,
    });
  });

  it("maps non-solid surface coloring sources to scalar color modes", () => {
    const settings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      surfaceColorSource: "component_z",
    } as const;

    expect(shaderUsesVertexColors(settings)).toBe(true);
    expect(surfaceScalarColorModeFromSettings(settings)).toBe("z");
  });

  it("reattaches instance colors and recompiles the glyph material for colored arrows", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial({
      color: "#222222",
      vertexColors: false,
    });
    const shaft = new InstancedMesh(geometry, material, 1);
    const head = new InstancedMesh(geometry, material, 1);
    const instanceColorAttr = new InstancedBufferAttribute(
      new Float32Array([1, 0, 0]),
      3,
    );
    const materialVersion = material.version;
    const attributeVersion = instanceColorAttr.version;

    syncVectorGlyphColorState({
      hasInstanceColors: true,
      head,
      instanceColorAttr,
      material,
      materialColor: "#222222",
      shaft,
    });

    expect(shaft.instanceColor).toBe(instanceColorAttr);
    expect(head.instanceColor).toBe(instanceColorAttr);
    expect(material.vertexColors).toBe(true);
    expect(material.color.getHexString()).toBe("ffffff");
    expect(material.version).toBeGreaterThan(materialVersion);
    expect(instanceColorAttr.version).toBeGreaterThan(attributeVersion);

    geometry.dispose();
    material.dispose();
  });

  it("updates glyph material style in place without replacing the material", () => {
    const material = new MeshBasicMaterial({
      color: "#222222",
      opacity: 1,
      transparent: false,
      vertexColors: false,
    });
    const materialVersion = material.version;

    syncVectorGlyphMaterialStyle({
      glyphTransparent: true,
      material,
      materialColor: "#ff3366",
      materialOpacity: 0.42,
      toneMapped: false,
      useInstanceColors: false,
    });

    expect(material.opacity).toBe(0.42);
    expect(material.transparent).toBe(true);
    expect(material.vertexColors).toBe(false);
    expect(material.color.getHexString()).toBe("ff3366");
    expect(material.version).toBeGreaterThan(materialVersion);

    material.dispose();
  });

  it("keeps glyph vertex colors white so instance colors are not multiplied to black", () => {
    const geometry = ensureWhiteVertexColorAttribute(new BoxGeometry(1, 1, 1));
    const color = geometry.getAttribute("color");

    expect(color?.itemSize).toBe(3);
    expect(color?.count).toBe(geometry.getAttribute("position").count);
    expect(Array.from(color.array)).toEqual(
      new Array(color.count * color.itemSize).fill(1),
    );

    geometry.dispose();
  });
});
