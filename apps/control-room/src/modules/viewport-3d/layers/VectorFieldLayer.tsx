"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
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

const VECTOR_GLYPH_UPLOAD_BATCH_SIZE = 256;
const VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS = 3;
const VECTOR_GLYPH_BUILD_MEASURE =
  "fullmag.viewport3d.buildVectorGlyphInstances";
const VECTOR_GLYPH_COLOR_UPLOAD_MEASURE =
  "fullmag.viewport3d.uploadVectorGlyphColors";
const VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE =
  "fullmag.viewport3d.uploadVectorGlyphMatrices";

interface VectorGlyphUploadBatch {
  end: number;
  start: number;
}

type VectorGlyphUploadTaskHandle = ReturnType<typeof setTimeout>;
type VectorGlyphInstances = NonNullable<
  ReturnType<typeof buildVectorGlyphInstances>
>;

interface VectorGlyphTransformScratch {
  direction: Vector3;
  matrix: Matrix4;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

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
  return setTimeout(callback, 16);
}

function cancelVectorGlyphUploadTask(handle: VectorGlyphUploadTaskHandle): void {
  clearTimeout(handle);
}

function nowVectorGlyphUploadMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function markVectorGlyphAttributeRange(
  attribute: InstancedBufferAttribute,
  start: number,
  count: number,
  itemSize: number,
): void {
  const safeStart = Math.max(0, Math.floor(start));
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= 0) return;
  attribute.addUpdateRange(safeStart * itemSize, safeCount * itemSize);
  attribute.needsUpdate = true;
}

function markVectorGlyphWork(name: string): string | null {
  const target = globalThis.performance;
  if (!target?.mark || !target?.measure) return null;

  const startMark = `${name}:start:${Date.now()}:${Math.random()}`;
  target.mark(startMark);
  return startMark;
}

function measureVectorGlyphWork(name: string, startMark: string | null): void {
  const target = globalThis.performance;
  if (!startMark || !target?.mark || !target?.measure) return;

  const endMark = `${name}:end:${Date.now()}:${Math.random()}`;
  target.mark(endMark);
  try {
    target.measure(name, startMark, endMark);
  } catch {
    // Gracefully ignore measurement errors
  } finally {
    target.clearMarks?.(startMark);
    target.clearMarks?.(endMark);
  }
}

function clearVectorGlyphWorkMark(startMark: string | null): void {
  if (!startMark) return;
  globalThis.performance?.clearMarks?.(startMark);
}

function measureVectorGlyphSyncWork<T>(name: string, task: () => T): T {
  const startMark = markVectorGlyphWork(name);
  try {
    return task();
  } finally {
    measureVectorGlyphWork(name, startMark);
  }
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

function createVectorGlyphTransformScratch(): VectorGlyphTransformScratch {
  return {
    direction: new Vector3(),
    matrix: new Matrix4(),
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(),
  };
}

function resolveVectorGlyphCapacity(glyphCount: number): number {
  const desired = Math.max(1, glyphCount);
  let next = 1;
  while (next < desired) next *= 2;
  return Math.min(next, 1 << 20); // cap at ~1M
}

function useTrackedVectorGlyphResources({
  tracker,
}: {
  tracker: Viewport3DResourceTracker;
}) {
  const glyphPolicy = RENDER_POLICIES.glyphs;
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

  return { glyphPolicy, headGeometry, material, shaftGeometry };
}

function useVectorGlyphMaterialSync({
  glyphPolicy,
  invalidate,
  material,
  materialProfile,
  materialColor,
  materialOpacity,
  tracker,
  useInstanceColors,
}: {
  glyphPolicy: typeof RENDER_POLICIES.glyphs;
  invalidate: () => void;
  material: MeshBasicMaterial;
  materialColor: string;
  materialOpacity: number;
  materialProfile?: Viewport3DMaterialProfile["glyphs"];
  tracker: Viewport3DResourceTracker;
  useInstanceColors: boolean;
}): void {
  useEffect(() => {
    syncVectorGlyphMaterialStyle({
      glyphTransparent: glyphPolicy.transparent,
      material,
      materialColor,
      materialOpacity,
      toneMapped: materialProfile?.toneMapped ?? false,
      useInstanceColors,
    });
    tracker.recordDirtyFrame("vector-glyph-material");
    invalidate();
  }, [
    material,
    materialOpacity,
    glyphPolicy.transparent,
    materialProfile?.toneMapped,
    useInstanceColors,
    materialColor,
    invalidate,
    tracker,
  ]);
}

function useVectorGlyphInstanceColorAttribute(
  capacity: number,
): RefObject<InstancedBufferAttribute | null> {
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

  return instanceColorAttrRef;
}

function useVectorGlyphUpload({
  glyphs,
  headRef,
  instanceColorAttrRef,
  invalidate,
  material,
  materialColor,
  shaftRef,
  tracker,
  transformScratch,
}: {
  glyphs: VectorGlyphInstances | null;
  headRef: RefObject<InstancedMesh | null>;
  instanceColorAttrRef: RefObject<InstancedBufferAttribute | null>;
  invalidate: () => void;
  material: MeshBasicMaterial;
  materialColor: string;
  shaftRef: RefObject<InstancedMesh | null>;
  tracker: Viewport3DResourceTracker;
  transformScratch: VectorGlyphTransformScratch;
}): void {
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
      materialColor,
      shaft: activeShaft,
    });
    activeShaft.instanceMatrix.setUsage(DynamicDrawUsage);
    activeHead.instanceMatrix.setUsage(DynamicDrawUsage);

    // Bulk color write instead of per-instance setColorAt.
    const glyphColors = activeGlyphs.colors;
    if (glyphColors) {
      measureVectorGlyphSyncWork(VECTOR_GLYPH_COLOR_UPLOAD_MEASURE, () => {
        const colorArray = instanceColorAttr.array as Float32Array;
        instanceColorAttr.clearUpdateRanges();
        colorArray.set(glyphColors.subarray(0, activeGlyphs.count * 3));
        markVectorGlyphAttributeRange(
          instanceColorAttr,
          0,
          activeGlyphs.count,
          3,
        );
      });
    }

    const batches = buildVectorGlyphUploadBatches(activeGlyphs.count);
    const { direction, matrix, position, quaternion, scale } = transformScratch;
    const startMark = markVectorGlyphWork(VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE);
    let batchIndex = 0;
    let cancelled = false;
    let measured = false;
    let task: VectorGlyphUploadTaskHandle | null = null;
    activeShaft.instanceMatrix.clearUpdateRanges();
    activeHead.instanceMatrix.clearUpdateRanges();

    function uploadNextBatch(): void {
      if (cancelled) return;

      task = null;
      const frameStart = nowVectorGlyphUploadMs();
      let uploadedCount = 0;

      while (batchIndex < batches.length) {
        const batch = batches[batchIndex];
        if (!batch) break;

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

        const batchCount = batch.end - batch.start;
        markVectorGlyphAttributeRange(
          activeShaft.instanceMatrix,
          batch.start,
          batchCount,
          16,
        );
        markVectorGlyphAttributeRange(
          activeHead.instanceMatrix,
          batch.start,
          batchCount,
          16,
        );
        uploadedCount += batchCount;
        batchIndex += 1;

        if (
          batchIndex < batches.length &&
          nowVectorGlyphUploadMs() - frameStart >=
            VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS
        ) {
          break;
        }
      }

      if (uploadedCount > 0) {
        tracker.recordDirtyFrame("vector-glyphs");
        invalidate();
      }

      if (batchIndex < batches.length) {
        task = requestVectorGlyphUploadTask(uploadNextBatch);
      } else {
        measureVectorGlyphWork(VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE, startMark);
        measured = true;
      }
    }

    uploadNextBatch();

    return () => {
      cancelled = true;
      if (task) {
        cancelVectorGlyphUploadTask(task);
      }
      if (!measured) {
        clearVectorGlyphWorkMark(startMark);
      }
    };
  }, [
    glyphs,
    headRef,
    invalidate,
    instanceColorAttrRef,
    material,
    materialColor,
    shaftRef,
    tracker,
    transformScratch,
  ]);
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
  const resolvedStyle = resolveVectorFieldLayerStyle({
    colorMode,
    fallbackColor: String(colors.field),
    opacity: opacity * (materialProfile?.opacityScale ?? 1),
    style,
  });
  const glyphs = useMemo(
    () =>
      segments
        ? measureVectorGlyphSyncWork(VECTOR_GLYPH_BUILD_MEASURE, () =>
            buildVectorGlyphInstances(segments, {
              colorMode,
              headRadiusRatio: resolvedStyle.headRadiusRatio,
              shaftRadiusRatio: resolvedStyle.shaftRadiusRatio,
            }),
          )
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
    () => createVectorGlyphTransformScratch(),
    [],
  );
  const capacity = useMemo(
    () => resolveVectorGlyphCapacity(glyphCount),
    [glyphCount],
  );
  const { glyphPolicy, headGeometry, material, shaftGeometry } =
    useTrackedVectorGlyphResources({ tracker });
  const instanceColorAttrRef = useVectorGlyphInstanceColorAttribute(capacity);

  useVectorGlyphMaterialSync({
    glyphPolicy,
    invalidate,
    material,
    materialColor: resolvedStyle.materialColor,
    materialOpacity: resolvedStyle.materialOpacity,
    materialProfile,
    tracker,
    useInstanceColors,
  });
  useVectorGlyphUpload({
    glyphs,
    headRef,
    instanceColorAttrRef,
    invalidate,
    material,
    materialColor: resolvedStyle.materialColor,
    shaftRef,
    tracker,
    transformScratch,
  });

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
