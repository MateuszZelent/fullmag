"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DColors } from "../viewport3dTypes";
import { buildVectorGlyphInstances } from "./vectorGlyphGeometry";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { RENDER_POLICIES } from "./viewport3DRenderPolicy";

const UNIT_Y = new Vector3(0, 1, 0);
// V1-matched proportions for better visual quality.
const DEFAULT_HEAD_RADIUS_RATIO = 0.20;
const DEFAULT_SHAFT_RADIUS_RATIO = 0.08;

const VECTOR_GLYPH_UPLOAD_BATCH_SIZE = 1024;

interface VectorGlyphUploadBatch {
  end: number;
  start: number;
}

type VectorGlyphUploadTaskHandle = ReturnType<typeof setTimeout>;

function buildVectorGlyphUploadBatches(
  count: number,
  batchSize = VECTOR_GLYPH_UPLOAD_BATCH_SIZE,
): VectorGlyphUploadBatch[] {
  const safeCount = Math.max(0, Math.floor(count));
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const batches: VectorGlyphUploadBatch[] = [];

  for (let start = 0; start < safeCount; start += safeBatchSize) {
    batches.push({ end: Math.min(start + safeBatchSize, safeCount), start });
  }

  return batches;
}

function requestVectorGlyphUploadTask(
  callback: () => void,
): VectorGlyphUploadTaskHandle {
  return setTimeout(callback, 0);
}

function cancelVectorGlyphUploadTask(handle: VectorGlyphUploadTaskHandle): void {
  clearTimeout(handle);
}

export interface VectorFieldLayerVectorStyle {
  alpha?: number | null;
  monoColor?: string | null;
  thickness?: number | null;
}

export function resolveVectorFieldLayerStyle({
  colorMode,
  fallbackColor,
  opacity,
  style,
}: {
  colorMode: string;
  fallbackColor: string;
  opacity: number;
  style?: VectorFieldLayerVectorStyle;
}) {
  const thickness = clampStyleScale(style?.thickness ?? 1);
  return {
    headRadiusRatio: DEFAULT_HEAD_RADIUS_RATIO * thickness,
    materialColor:
      colorMode === "monochrome" && style?.monoColor
        ? style.monoColor
        : fallbackColor,
    materialOpacity: clampOpacity(opacity * (style?.alpha ?? 1)),
    shaftRadiusRatio: DEFAULT_SHAFT_RADIUS_RATIO * thickness,
  };
}

export function syncVectorGlyphColorState({
  hasInstanceColors,
  head,
  instanceColorAttr,
  material,
  materialColor,
  shaft,
}: {
  hasInstanceColors: boolean;
  head: InstancedMesh;
  instanceColorAttr: InstancedBufferAttribute;
  material: MeshBasicMaterial;
  materialColor: string;
  shaft: InstancedMesh;
}) {
  const nextInstanceColor = hasInstanceColors ? instanceColorAttr : null;
  shaft.instanceColor = nextInstanceColor;
  head.instanceColor = nextInstanceColor;
  material.vertexColors = hasInstanceColors;
  material.color.set(hasInstanceColors ? "white" : materialColor);
  if (hasInstanceColors) {
    instanceColorAttr.needsUpdate = true;
  }
  material.needsUpdate = true;
}

export function syncVectorGlyphMaterialStyle({
  glyphTransparent,
  material,
  materialColor,
  materialOpacity,
  toneMapped,
  useInstanceColors,
}: {
  glyphTransparent: boolean;
  material: MeshBasicMaterial;
  materialColor: string;
  materialOpacity: number;
  toneMapped: boolean;
  useInstanceColors: boolean;
}) {
  material.opacity = materialOpacity;
  material.transparent = glyphTransparent || materialOpacity < 0.99;
  material.toneMapped = toneMapped;
  material.vertexColors = useInstanceColors;
  material.color.set(useInstanceColors ? "white" : materialColor);
  material.needsUpdate = true;
}

export function ensureWhiteVertexColorAttribute(
  geometry: BufferGeometry,
): BufferGeometry {
  const position = geometry.getAttribute("position");
  const vertexCount = position?.count ?? 0;
  const existing = geometry.getAttribute("color");
  if (existing?.itemSize === 3 && existing.count === vertexCount) {
    return geometry;
  }

  const colors = new Float32Array(vertexCount * 3);
  colors.fill(1);
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

export function VectorFieldLayer({
  colors,
  colorMode = "orientation",
  opacity = 1,
  segments,
  style,
  materialProfile,
  tracker,
}: {
  colors: Viewport3DColors;
  colorMode?: string;
  materialProfile?: Viewport3DMaterialProfile["glyphs"];
  opacity?: number;
  segments: Float32Array | null;
  style?: VectorFieldLayerVectorStyle;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const shaftRef = useRef<InstancedMesh>(null);
  const headRef = useRef<InstancedMesh>(null);
  const glyphPolicy = RENDER_POLICIES.glyphs;
  const resolvedStyle = resolveVectorFieldLayerStyle({
    colorMode,
    fallbackColor: String(colors.field),
    opacity: opacity * (materialProfile?.opacityScale ?? 1),
    style,
  });
  const glyphs = useMemo(
    () =>
      segments
        ? buildVectorGlyphInstances(segments, {
            colorMode,
            headRadiusRatio: resolvedStyle.headRadiusRatio,
            shaftRadiusRatio: resolvedStyle.shaftRadiusRatio,
          })
        : null,
    [
      colorMode,
      resolvedStyle.headRadiusRatio,
      resolvedStyle.shaftRadiusRatio,
      segments,
    ],
  );
  const useInstanceColors = Boolean(glyphs?.colors);
  const glyphCount = glyphs?.count ?? 0;
  const transformScratch = useMemo(
    () => ({
      direction: new Vector3(),
      matrix: new Matrix4(),
      position: new Vector3(),
      quaternion: new Quaternion(),
      scale: new Vector3(),
    }),
    [],
  );

  // Stable power-of-two capacity keeps allocations bounded without render-time
  // ref reads, which React Compiler rejects.
  const capacity = useMemo(() => {
    const desired = Math.max(1, glyphCount);
    let next = 1;
    while (next < desired) next *= 2;
    return Math.min(next, 1 << 20); // cap at ~1M
  }, [glyphCount]);

  const shaftGeometry = useMemo(
    () =>
      tracker.track(
        "geometry",
        ensureWhiteVertexColorAttribute(
          new CylinderGeometry(1, 1, 1, 12, 1),
        ),
      ),
    [tracker],
  );
  const headGeometry = useMemo(
    () =>
      tracker.track(
        "geometry",
        ensureWhiteVertexColorAttribute(new ConeGeometry(1, 1, 12, 1)),
      ),
    [tracker],
  );
  const material = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          depthWrite: glyphPolicy.depthWrite,
          depthTest: glyphPolicy.depthTest,
          side: glyphPolicy.side,
        }),
      ),
    [glyphPolicy, tracker],
  );

  useEffect(() => {
    syncVectorGlyphMaterialStyle({
      glyphTransparent: glyphPolicy.transparent,
      material,
      materialColor: resolvedStyle.materialColor,
      materialOpacity: resolvedStyle.materialOpacity,
      toneMapped: materialProfile?.toneMapped ?? false,
      useInstanceColors,
    });
    invalidate();
  }, [
    material,
    resolvedStyle.materialOpacity,
    glyphPolicy.transparent,
    materialProfile?.toneMapped,
    useInstanceColors,
    resolvedStyle.materialColor,
    invalidate,
  ]);

  const instanceColorAttrRef = useRef<InstancedBufferAttribute | null>(null);

  useEffect(() => {
    const attr = new InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    attr.setUsage(DynamicDrawUsage);
    instanceColorAttrRef.current = attr;
    return () => {
      if (instanceColorAttrRef.current === attr) {
        instanceColorAttrRef.current = null;
      }
    };
  }, [capacity]);

  useEffect(
    () => () => tracker.release("geometry", shaftGeometry),
    [shaftGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", headGeometry),
    [headGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("material", material),
    [material, tracker],
  );

  useEffect(() => {
    const shaft = shaftRef.current;
    const head = headRef.current;
    const instanceColorAttr = instanceColorAttrRef.current;
    if (!glyphs || !shaft || !head || !instanceColorAttr) return;

    const activeGlyphs = glyphs;
    const activeShaft = shaft;
    const activeHead = head;

    // Set visible count (may be less than capacity).
    activeShaft.count = activeGlyphs.count;
    activeHead.count = activeGlyphs.count;

    // Attach instance color attribute for bulk writes.
    syncVectorGlyphColorState({
      hasInstanceColors: Boolean(glyphs.colors),
      head: activeHead,
      instanceColorAttr,
      material,
      materialColor: resolvedStyle.materialColor,
      shaft: activeShaft,
    });
    activeShaft.instanceMatrix.setUsage(DynamicDrawUsage);
    activeHead.instanceMatrix.setUsage(DynamicDrawUsage);

    // Bulk color write instead of per-instance setColorAt.
    const glyphColors = activeGlyphs.colors;
    if (glyphColors) {
      const colorArray = instanceColorAttr.array as Float32Array;
      colorArray.set(glyphColors.subarray(0, activeGlyphs.count * 3));
      instanceColorAttr.needsUpdate = true;
    }

    const batches = buildVectorGlyphUploadBatches(activeGlyphs.count);
    const { direction, matrix, position, quaternion, scale } = transformScratch;
    let batchIndex = 0;
    let cancelled = false;
    let task: VectorGlyphUploadTaskHandle | null = null;

    function uploadNextBatch(): void {
      if (cancelled) return;

      const batch = batches[batchIndex];
      if (!batch) return;

      for (let index = batch.start; index < batch.end; index += 1) {
        const offset = index * 3;
        direction.set(
          activeGlyphs.directions[offset] ?? 0,
          activeGlyphs.directions[offset + 1] ?? 1,
          activeGlyphs.directions[offset + 2] ?? 0,
        );
        quaternion.setFromUnitVectors(UNIT_Y, direction);

        position.set(
          activeGlyphs.shaftCenters[offset] ?? 0,
          activeGlyphs.shaftCenters[offset + 1] ?? 0,
          activeGlyphs.shaftCenters[offset + 2] ?? 0,
        );
        scale.set(
          activeGlyphs.shaftScales[offset] ?? 0,
          activeGlyphs.shaftScales[offset + 1] ?? 0,
          activeGlyphs.shaftScales[offset + 2] ?? 0,
        );
        matrix.compose(position, quaternion, scale);
        activeShaft.setMatrixAt(index, matrix);

        position.set(
          activeGlyphs.headCenters[offset] ?? 0,
          activeGlyphs.headCenters[offset + 1] ?? 0,
          activeGlyphs.headCenters[offset + 2] ?? 0,
        );
        scale.set(
          activeGlyphs.headScales[offset] ?? 0,
          activeGlyphs.headScales[offset + 1] ?? 0,
          activeGlyphs.headScales[offset + 2] ?? 0,
        );
        matrix.compose(position, quaternion, scale);
        activeHead.setMatrixAt(index, matrix);
      }

      activeShaft.instanceMatrix.needsUpdate = true;
      activeHead.instanceMatrix.needsUpdate = true;
      tracker.recordDirtyFrame("vector-glyphs");
      invalidate();

      batchIndex += 1;
      if (batchIndex < batches.length) {
        task = requestVectorGlyphUploadTask(uploadNextBatch);
      }
    }

    uploadNextBatch();

    return () => {
      cancelled = true;
      if (task) {
        cancelVectorGlyphUploadTask(task);
      }
    };
  }, [
    glyphs,
    invalidate,
    material,
    resolvedStyle.materialColor,
    tracker,
    transformScratch,
  ]);

  if (!glyphs || glyphs.count === 0) return null;

  return (
    <>
      <instancedMesh
        args={[shaftGeometry, material, capacity]}
        frustumCulled={false}
        key={`vector-shaft-${capacity}`}
        ref={shaftRef}
        renderOrder={glyphPolicy.renderOrder}
      />
      <instancedMesh
        args={[headGeometry, material, capacity]}
        frustumCulled={false}
        key={`vector-head-${capacity}`}
        ref={headRef}
        renderOrder={glyphPolicy.renderOrder}
      />
    </>
  );
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampStyleScale(value: number): number {
  return Math.max(0.1, Math.min(8, value));
}
