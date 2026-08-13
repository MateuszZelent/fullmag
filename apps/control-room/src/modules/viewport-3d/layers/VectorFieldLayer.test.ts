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
  createVectorGlyphColorUploadRollback,
  createVectorGlyphMatrixUploadRollback,
  createVectorGlyphUploadKeys,
  ensureWhiteVertexColorAttribute,
  identifyVectorGlyphBuildResult,
  recordVectorFieldAdoption,
  resolveVectorGlyphDepthPolicy,
  resolveVectorFieldAdoptionBuildKey,
  resolveVectorFieldLayerStyle,
  syncVectorGlyphMaterialStyle,
  syncVectorGlyphColorState,
} from "./VectorFieldLayer";
import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import { createViewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";

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
  it("keeps FDM glyph overlays visible over opaque cell surfaces", () => {
    expect(resolveVectorGlyphDepthPolicy()).toEqual({
      depthTest: true,
      depthWrite: true,
    });
    expect(resolveVectorGlyphDepthPolicy(true)).toEqual({
      depthTest: false,
      depthWrite: false,
    });
  });

  it("creates a stable instanced color attribute for GPU uploads", () => {
    expect(vectorFieldLayerSource).toContain("return useMemo(() => {");
    expect(vectorFieldLayerSource).toContain("new InstancedBufferAttribute(");
    expect(vectorFieldLayerSource).toContain(
      "instanceColorAttr,\n    invalidate,",
    );
  });

  it("clears the exact vector receipt when no build remains or the layer unmounts", () => {
    expect(vectorFieldLayerSource).toContain("adoptionRegistry.clearAdoption(");
    expect(vectorFieldLayerSource).toContain("if (glyphBuild || !adoptionRegistry || !carrierId) return;");
    expect(vectorFieldLayerSource).toContain("unregister();");
  });
  it("preserves the retained vector build source when a newer source is requested", () => {
    const retained = identifyVectorGlyphBuildResult(
      {
        colors: null,
        transforms: {
          count: 0,
          directions: new Float32Array(),
          headCenters: new Float32Array(),
          headScales: new Float32Array(),
          shaftCenters: new Float32Array(),
          shaftScales: new Float32Array(),
        },
      },
      {
        buildKey: "vector-old",
        fieldBufferId: "field-old",
        fieldRevision: "old",
        groupKey: "group",
        resourceKey: "resource-old",
        revisionSummary: "old",
        targetRevision: "field=old",
        topologyRevision: "mesh-1",
      },
    );

    expect(retained).toMatchObject({
      sourceFieldBufferId: "field-old",
      sourceResourceKey: "resource-old",
      sourceVectorBuildKey: "vector-old",
    });
    expect(resolveVectorFieldAdoptionBuildKey(retained)).toBe("vector-old");
  });
  it("does not fabricate an adoption source from a decorated upload key", () => {
    expect(
      resolveVectorFieldAdoptionBuildKey({
        colors: null,
        transforms: {
          count: 0,
          directions: new Float32Array(),
          headCenters: new Float32Array(),
          headScales: new Float32Array(),
          shaftCenters: new Float32Array(),
          shaftScales: new Float32Array(),
        },
      }),
    ).toBeNull();
  });
  it("records target-specific vector evidence only after visible adoption", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["part:a", ["object:a"]]]));
    registry.retainDemand("object:a");

    recordVectorFieldAdoption({
      buildKey: "vector-adopted",
      byteLength: 144,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      glyphCount: 7,
      registry,
    });

    expect(registry.snapshot("object:a")[0]).toMatchObject({
      byteLength: 144,
      fieldBufferId: "field-a",
      itemCount: 7,
      vectorBuildKey: "vector-adopted",
    });
  });
  it("passes the stable layer owner on the first visible vector adoption", () => {
    const recordStart = vectorFieldLayerSource.indexOf(
      "const recordAdoption = useCallback",
    );
    const firstRecordBlock = vectorFieldLayerSource.slice(
      recordStart,
      vectorFieldLayerSource.indexOf("useEffect(() => {", recordStart),
    );

    expect(firstRecordBlock).toContain("ownerId: adoptionOwnerId");
  });
  it("restores a partially uploaded glyph color lane after a later chunk fails", () => {
    const scheduled: Array<() => void> = [];
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial({ color: "#224466", vertexColors: false });
    const shaft = new InstancedMesh(geometry, material, 2);
    const head = new InstancedMesh(geometry, material, 2);
    shaft.count = 1;
    head.count = 1;
    const attribute = new InstancedBufferAttribute(
      new Float32Array([1, 0, 0, 0, 1, 0]),
      3,
    );
    attribute.addUpdateRange(3, 3);
    const firstRollback = createVectorGlyphColorUploadRollback({
      attribute,
      count: 1,
      head,
      material,
      shaft,
      start: 0,
    });
    const secondRollback = createVectorGlyphColorUploadRollback({
      attribute,
      count: 1,
      head,
      material,
      shaft,
      start: 1,
    });
    const manager = createViewport3DGpuUploadManager({
      cancelFrame: () => {},
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    manager.enqueue({
      chunks: [
        {
          estimatedBytes: 12,
          itemCount: 1,
          rollback: firstRollback,
          upload: () => attribute.array.set([0, 0, 1], 0),
        },
        {
          estimatedBytes: 12,
          itemCount: 1,
          rollback: secondRollback,
          upload: () => {
            attribute.array.set([1, 1, 1], 3);
            throw new Error("color chunk failed");
          },
        },
      ],
      estimatedBytes: 24,
      key: "vector-color-failure",
      lane: "vector-glyph",
      onVisible: () => {},
      targetRevision: "field=f1",
    });
    scheduled.shift()?.();

    expect(Array.from(attribute.array)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(shaft.count).toBe(1);
    expect(head.count).toBe(1);
    expect(material.vertexColors).toBe(false);
    expect(attribute.updateRanges).toEqual([{ count: 3, start: 3 }]);
    geometry.dispose();
    material.dispose();
  });

  it("restores all glyph matrix changes when visible adoption fails", () => {
    const scheduled: Array<() => void> = [];
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial();
    const shaft = new InstancedMesh(geometry, material, 2);
    const head = new InstancedMesh(geometry, material, 2);
    shaft.count = 1;
    head.count = 1;
    shaft.instanceMatrix.addUpdateRange(0, 16);
    head.instanceMatrix.addUpdateRange(16, 16);
    const originalShaft = Array.from(shaft.instanceMatrix.array);
    const originalHead = Array.from(head.instanceMatrix.array);
    const firstRollback = createVectorGlyphMatrixUploadRollback({
      count: 1,
      head,
      shaft,
      start: 0,
    });
    const secondRollback = createVectorGlyphMatrixUploadRollback({
      count: 1,
      head,
      shaft,
      start: 1,
    });
    const manager = createViewport3DGpuUploadManager({
      cancelFrame: () => {},
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    manager.enqueue({
      chunks: [
        {
          estimatedBytes: 128,
          itemCount: 1,
          rollback: firstRollback,
          upload: () => shaft.instanceMatrix.array.fill(7, 0, 16),
        },
        {
          estimatedBytes: 128,
          itemCount: 1,
          rollback: secondRollback,
          upload: () => head.instanceMatrix.array.fill(9, 16, 32),
        },
      ],
      estimatedBytes: 256,
      key: "vector-matrix-visible-failure",
      lane: "vector-glyph",
      onVisible: () => {
        shaft.count = 2;
        head.count = 2;
        throw new Error("visible failed");
      },
      targetRevision: "field=f1",
    });
    scheduled.shift()?.();

    expect(Array.from(shaft.instanceMatrix.array)).toEqual(originalShaft);
    expect(Array.from(head.instanceMatrix.array)).toEqual(originalHead);
    expect(shaft.count).toBe(1);
    expect(head.count).toBe(1);
    expect(shaft.instanceMatrix.updateRanges).toEqual([
      { count: 16, start: 0 },
    ]);
    expect(head.instanceMatrix.updateRanges).toEqual([
      { count: 16, start: 16 },
    ]);
    geometry.dispose();
    material.dispose();
  });

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
    expect(buildHookSource).toContain("const normalizedBuildKey = buildKey ?? null;");
    expect(buildHookSource).toContain(
      "snapshot.buildKey === normalizedBuildKey",
    );
    expect(buildHookSource).toContain("useSyncExternalStore");
    expect(buildHookSource).toContain("AbortController");
    expect(buildHookSource).toContain("useVectorGlyphDerivedBufferCache");
    expect(buildHookSource).toContain("resolveVisible");
    expect(buildHookSource).toContain('cached.state === "ready-current"');
    expect(buildHookSource).toContain("result: cached.entry.buffer");
    expect(buildHookSource).toContain("retainedBuildRef");
    expect(buildHookSource).toContain("cache.tryRetain(visibleCacheKey)");
    expect(buildHookSource).toContain(
      "if (!retainedVisibleBuild) return undefined;",
    );
    expect(buildHookSource).toContain("cache.evictStaleRevisions");
    expect(buildHookSource).toContain("cache.evictInactiveGroups");
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
      surfaceOpacityPercent: 50,
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
    expect(wireframeOpacityFromSettings(settings)).toBe(0.3);
    expect(
      wireframeOpacityFromSettings(settings, { opacity: 0.42 }),
    ).toBe(0.126);
    expect(vectorColorModeFromSettings(settings, "orientation")).toBe("x");
    expect(vectorStyleFromSettings(settings, {})).toEqual({
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
