"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
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
import type { Viewport3DDerivedBufferRetainHandle } from "../build-engine/cache/viewport3dDerivedBufferCache";
import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import type { Viewport3DGpuUploadChunk } from "../build-engine/gpu/viewport3dGpuUploadTypes";
import type { Viewport3DVectorBuildReference } from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { VectorGlyphTransforms } from "./vectorGlyphGeometry";
import {
  buildViewport3DVectorGlyphsOffMainThread,
  type VectorGlyphBuildRequest,
  type VectorGlyphBuildResult,
} from "./vectorGlyphBuildScheduler";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { RENDER_POLICIES } from "./viewport3DRenderPolicy";
import { useVectorGlyphDerivedBufferCache } from "./vectorGlyphDerivedBufferRuntime";

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

interface VectorGlyphTransformScratch {
  direction: Vector3;
  matrix: Matrix4;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

interface VectorGlyphBuildSnapshot {
  buildKey: string | null;
  request: VectorGlyphBuildRequest | null;
  result: VectorGlyphBuildResult | null;
}

export interface VectorGlyphUploadKeys {
  colorKey: string;
  matrixKey: string;
  targetRevision: string | null;
}

export interface VectorGlyphUploadKeyInput {
  buildKey: string;
  colorByteLength: number;
  glyphCount: number;
  targetRevision: string | null;
  transformByteLength: number;
}

interface VectorGlyphBuildStore {
  getSnapshot: () => VectorGlyphBuildSnapshot;
  publish: (snapshot: VectorGlyphBuildSnapshot) => void;
  subscribe: (listener: () => void) => () => void;
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

export function createVectorGlyphColorUploadRollback({
  attribute,
  count,
  head,
  material,
  shaft,
  start,
}: {
  attribute: InstancedBufferAttribute;
  count: number;
  head: InstancedMesh;
  material: MeshBasicMaterial;
  shaft: InstancedMesh;
  start: number;
}): () => void {
  const colorStart = start * 3;
  const priorColors = (attribute.array as Float32Array).slice(
    colorStart,
    colorStart + count * 3,
  );
  const priorRanges = attribute.updateRanges.map(({ count: rangeCount, start: rangeStart }) => ({
    count: rangeCount,
    start: rangeStart,
  }));
  const priorHeadCount = head.count;
  const priorHeadInstanceColor = head.instanceColor;
  const priorMaterialColor = material.color.clone();
  const priorMaterialVertexColors = material.vertexColors;
  const priorShaftCount = shaft.count;
  const priorShaftInstanceColor = shaft.instanceColor;

  return () => {
    (attribute.array as Float32Array).set(priorColors, colorStart);
    restoreVectorGlyphUpdateRanges(attribute, priorRanges);
    shaft.count = priorShaftCount;
    head.count = priorHeadCount;
    shaft.instanceColor = priorShaftInstanceColor;
    head.instanceColor = priorHeadInstanceColor;
    material.color.copy(priorMaterialColor);
    material.vertexColors = priorMaterialVertexColors;
    material.needsUpdate = true;
  };
}

export function createVectorGlyphMatrixUploadRollback({
  count,
  head,
  shaft,
  start,
}: {
  count: number;
  head: InstancedMesh;
  shaft: InstancedMesh;
  start: number;
}): () => void {
  const matrixStart = start * 16;
  const matrixLength = count * 16;
  const priorHeadMatrices = (head.instanceMatrix.array as Float32Array).slice(
    matrixStart,
    matrixStart + matrixLength,
  );
  const priorHeadRanges = head.instanceMatrix.updateRanges.map(
    ({ count: rangeCount, start: rangeStart }) => ({
      count: rangeCount,
      start: rangeStart,
    }),
  );
  const priorHeadCount = head.count;
  const priorShaftMatrices = (shaft.instanceMatrix.array as Float32Array).slice(
    matrixStart,
    matrixStart + matrixLength,
  );
  const priorShaftRanges = shaft.instanceMatrix.updateRanges.map(
    ({ count: rangeCount, start: rangeStart }) => ({
      count: rangeCount,
      start: rangeStart,
    }),
  );
  const priorShaftCount = shaft.count;

  return () => {
    (shaft.instanceMatrix.array as Float32Array).set(
      priorShaftMatrices,
      matrixStart,
    );
    (head.instanceMatrix.array as Float32Array).set(
      priorHeadMatrices,
      matrixStart,
    );
    restoreVectorGlyphUpdateRanges(shaft.instanceMatrix, priorShaftRanges);
    restoreVectorGlyphUpdateRanges(head.instanceMatrix, priorHeadRanges);
    shaft.count = priorShaftCount;
    head.count = priorHeadCount;
  };
}

function restoreVectorGlyphUpdateRanges(
  attribute: InstancedBufferAttribute,
  ranges: readonly { readonly count: number; readonly start: number }[],
): void {
  attribute.clearUpdateRanges();
  for (const range of ranges) {
    attribute.addUpdateRange(range.start, range.count);
  }
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

function createVectorGlyphBuildStore(): VectorGlyphBuildStore {
  let snapshot: VectorGlyphBuildSnapshot = {
    buildKey: null,
    request: null,
    result: null,
  };
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    publish: (nextSnapshot) => {
      if (
        snapshot.buildKey === nextSnapshot.buildKey &&
        snapshot.request === nextSnapshot.request &&
        snapshot.result === nextSnapshot.result
      ) {
        return;
      }
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function estimateVectorGlyphBuildResultBytes(
  result: VectorGlyphBuildResult,
): number {
  return (
    (result.colors?.byteLength ?? 0) +
    estimateVectorGlyphTransformBytes(result.transforms)
  );
}

function estimateVectorGlyphTransformBytes(
  transforms: VectorGlyphTransforms | null,
): number {
  if (!transforms) return 0;
  return (
    transforms.directions.byteLength +
    transforms.headCenters.byteLength +
    transforms.headScales.byteLength +
    transforms.shaftCenters.byteLength +
    transforms.shaftScales.byteLength
  );
}

export function createVectorGlyphUploadKeys({
  buildKey,
  colorByteLength,
  glyphCount,
  targetRevision,
  transformByteLength,
}: VectorGlyphUploadKeyInput): VectorGlyphUploadKeys {
  const targetKey = targetRevision ?? "unknown";
  const baseKey = `${buildKey}:target=${targetKey}:count=${glyphCount}`;
  return {
    colorKey: `vector-glyph-colors:${baseKey}:bytes=${colorByteLength}`,
    matrixKey: `vector-glyph-matrices:${baseKey}:bytes=${transformByteLength}`,
    targetRevision,
  };
}

function createVectorGlyphSemanticBuildKey({
  buildReference,
  colorMode,
  headRadiusRatio,
  shaftRadiusRatio,
}: {
  buildReference?: Viewport3DVectorBuildReference | null;
  colorMode: string;
  headRadiusRatio: number;
  shaftRadiusRatio: number;
}): string | undefined {
  if (!buildReference) return undefined;
  return [
    buildReference.buildKey,
    `color=${colorMode}`,
    `head=${headRadiusRatio}`,
    `shaft=${shaftRadiusRatio}`,
  ].join(":");
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

function useVectorGlyphBuild({
  buildKey,
  buildReference,
  colorMode,
  headRadiusRatio,
  invalidate,
  segments,
  shaftRadiusRatio,
  tracker,
}: {
  buildKey?: string;
  buildReference?: Viewport3DVectorBuildReference | null;
  colorMode: string;
  headRadiusRatio: number;
  invalidate: () => void;
  segments: Float32Array | null;
  shaftRadiusRatio: number;
  tracker: Viewport3DResourceTracker;
}): VectorGlyphBuildResult | null {
  const store = useMemo(() => createVectorGlyphBuildStore(), []);
  const cache = useVectorGlyphDerivedBufferCache();
  const retainedBuildRef =
    useRef<Viewport3DDerivedBufferRetainHandle<VectorGlyphBuildResult> | null>(
      null,
    );
  const activeGroupKey = buildReference?.groupKey ?? null;
  const request = useMemo<VectorGlyphBuildRequest | null>(
    () =>
      segments
        ? {
            colorMode,
            headRadiusRatio,
            segments,
            shaftRadiusRatio,
          }
        : null,
    [colorMode, headRadiusRatio, segments, shaftRadiusRatio],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => {
    if (!request) return;

    const abortController = new AbortController();
    const startMark = markVectorGlyphWork(VECTOR_GLYPH_BUILD_MEASURE);
    let measured = false;

    void buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: buildKey,
      groupKey: buildReference?.groupKey,
      latestWins: true,
      revisionSummary: buildReference?.revisionSummary,
      signal: abortController.signal,
    })
      .then((result) => {
        if (abortController.signal.aborted) return;
        if (buildReference && buildKey) {
          cache.putReady({
            buffer: result,
            estimatedBytes: estimateVectorGlyphBuildResultBytes(result),
            fieldRevision: buildReference.fieldRevision,
            groupKey: buildReference.groupKey,
            key: buildKey,
            lane: "vector-glyph",
            targetRevision: buildReference.targetRevision,
            topologyRevision: buildReference.topologyRevision,
          });
        }
        store.publish({ buildKey: buildKey ?? null, request, result });
        measureVectorGlyphWork(VECTOR_GLYPH_BUILD_MEASURE, startMark);
        measured = true;
        tracker.recordDirtyFrame("vector-glyph-build");
        invalidate();
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        measureVectorGlyphWork(VECTOR_GLYPH_BUILD_MEASURE, startMark);
        measured = true;
      });

    return () => {
      abortController.abort();
      if (!measured) {
        clearVectorGlyphWorkMark(startMark);
      }
    };
  }, [buildKey, buildReference, cache, invalidate, request, store, tracker]);

  useEffect(() => {
    if (!activeGroupKey) return;
    cache.evictInactiveGroups({
      activeGroupKey,
      lane: "vector-glyph",
    });
  }, [activeGroupKey, cache]);

  let visibleCacheKey: string | null = null;
  let visibleResult: VectorGlyphBuildResult | null = null;
  if (request) {
    if (snapshot.request === request && snapshot.buildKey === buildKey) {
      visibleResult = snapshot.result;
      visibleCacheKey =
        snapshot.result && snapshot.buildKey ? snapshot.buildKey : null;
    } else if (buildReference && buildKey) {
      const resolved = cache.resolveVisible({
        fieldRevision: buildReference.fieldRevision,
        groupKey: buildReference.groupKey,
        key: buildKey,
        lane: "vector-glyph",
        targetRevision: buildReference.targetRevision,
        topologyRevision: buildReference.topologyRevision,
      });
      if (
        resolved.state === "ready-current" ||
        resolved.state === "stale-compatible" ||
        resolved.state === "stale-physical"
      ) {
        visibleResult = resolved.entry?.buffer ?? null;
        visibleCacheKey = resolved.entry?.key ?? null;
      }
    }
  }

  useEffect(() => {
    if (retainedBuildRef.current?.entry.key === visibleCacheKey) return;

    if (retainedBuildRef.current) {
      retainedBuildRef.current.release();
      retainedBuildRef.current = null;
    }

    if (!visibleCacheKey) return;

    const retainedVisibleBuild = cache.tryRetain(visibleCacheKey);
    if (!retainedVisibleBuild) return undefined;

    retainedBuildRef.current = retainedVisibleBuild;
    if (buildReference) {
      cache.evictStaleRevisions({
        fieldRevision: buildReference.fieldRevision,
        groupKey: buildReference.groupKey,
        lane: "vector-glyph",
        topologyRevision: buildReference.topologyRevision,
      });
    }
    return () => {
      if (retainedBuildRef.current?.entry.key === visibleCacheKey) {
        retainedBuildRef.current.release();
        retainedBuildRef.current = null;
      }
    };
  }, [buildReference, cache, visibleCacheKey]);

  return visibleResult;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "Vector glyph build aborted")
  );
}

function useVectorGlyphUpload({
  buildKey,
  glyphColors,
  glyphCount,
  glyphTransforms,
  headRef,
  instanceColorAttrRef,
  invalidate,
  material,
  materialColor,
  shaftRef,
  targetRevision,
  tracker,
  transformScratch,
}: {
  buildKey?: string | null;
  glyphColors: Float32Array | null;
  glyphCount: number;
  glyphTransforms: VectorGlyphTransforms | null;
  headRef: RefObject<InstancedMesh | null>;
  instanceColorAttrRef: RefObject<InstancedBufferAttribute | null>;
  invalidate: () => void;
  material: MeshBasicMaterial;
  materialColor: string;
  shaftRef: RefObject<InstancedMesh | null>;
  targetRevision?: string | null;
  tracker: Viewport3DResourceTracker;
  transformScratch: VectorGlyphTransformScratch;
}): void {
  const uploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );

  useEffect(() => () => uploadManager.dispose(), [uploadManager]);

  useEffect(() => {
    const shaft = shaftRef.current;
    const head = headRef.current;
    const instanceColorAttr = instanceColorAttrRef.current;
    if (!shaft || !head || !instanceColorAttr) return;

    if (!glyphColors) {
      shaft.count = glyphCount;
      head.count = glyphCount;
      syncVectorGlyphColorState({
        hasInstanceColors: false,
        head,
        instanceColorAttr,
        material,
        materialColor,
        shaft,
      });
      tracker.recordDirtyFrame("vector-glyph-colors");
      invalidate();
      return;
    }

    const colorArray = instanceColorAttr.array as Float32Array;
    const batches = buildVectorGlyphUploadBatches(glyphCount);
    const uploadKeys = buildKey
      ? createVectorGlyphUploadKeys({
          buildKey,
          colorByteLength: glyphColors.byteLength,
          glyphCount,
          targetRevision: targetRevision ?? null,
          transformByteLength: 0,
        })
      : null;
    const abortController = new AbortController();
    const startMark = markVectorGlyphWork(VECTOR_GLYPH_COLOR_UPLOAD_MEASURE);
    let measured = false;
    const rollbacks = batches.map((batch) =>
      createVectorGlyphColorUploadRollback({
        attribute: instanceColorAttr,
        count: batch.end - batch.start,
        head,
        material,
        shaft,
        start: batch.start,
      }),
    );
    instanceColorAttr.clearUpdateRanges();

    const chunks: Viewport3DGpuUploadChunk[] = batches.map((batch, index) => ({
      estimatedBytes:
        (batch.end - batch.start) * 3 * Float32Array.BYTES_PER_ELEMENT,
      itemCount: batch.end - batch.start,
      upload: () => {
        colorArray.set(
          glyphColors.subarray(batch.start * 3, batch.end * 3),
          batch.start * 3,
        );
      },
      rollback: rollbacks[index],
    }));

    uploadManager.enqueue({
      chunks,
      estimatedBytes: glyphColors.byteLength,
      key:
        uploadKeys?.colorKey ??
        `vector-glyph-colors:${glyphCount}:${glyphColors.byteLength}`,
      lane: "vector-glyph",
      onVisible: () => {
        shaft.count = glyphCount;
        head.count = glyphCount;
        syncVectorGlyphColorState({
          hasInstanceColors: true,
          head,
          instanceColorAttr,
          material,
          materialColor,
          shaft,
        });
        markVectorGlyphAttributeRange(instanceColorAttr, 0, glyphCount, 3);
        measureVectorGlyphWork(VECTOR_GLYPH_COLOR_UPLOAD_MEASURE, startMark);
        measured = true;
        tracker.recordDirtyFrame("vector-glyph-colors");
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: uploadKeys?.targetRevision ?? null,
    });

    return () => {
      abortController.abort();
      if (!measured) {
        clearVectorGlyphWorkMark(startMark);
      }
    };
  }, [
    buildKey,
    glyphColors,
    glyphCount,
    headRef,
    instanceColorAttrRef,
    invalidate,
    material,
    materialColor,
    shaftRef,
    targetRevision,
    tracker,
    uploadManager,
  ]);

  useEffect(() => {
    const shaft = shaftRef.current;
    const head = headRef.current;
    if (!glyphTransforms || !shaft || !head) return;

    const activeGlyphs = glyphTransforms;
    const activeShaft = shaft;
    const activeHead = head;

    activeShaft.instanceMatrix.setUsage(DynamicDrawUsage);
    activeHead.instanceMatrix.setUsage(DynamicDrawUsage);

    const batches = buildVectorGlyphUploadBatches(activeGlyphs.count);
    const { direction, matrix, position, quaternion, scale } = transformScratch;
    const startMark = markVectorGlyphWork(VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE);
    let measured = false;
    const abortController = new AbortController();
    const rollbacks = batches.map((batch) =>
      createVectorGlyphMatrixUploadRollback({
        count: batch.end - batch.start,
        head: activeHead,
        shaft: activeShaft,
        start: batch.start,
      }),
    );
    activeShaft.instanceMatrix.clearUpdateRanges();
    activeHead.instanceMatrix.clearUpdateRanges();
    const transformByteLength = estimateVectorGlyphTransformBytes(activeGlyphs);
    const uploadKeys = buildKey
      ? createVectorGlyphUploadKeys({
          buildKey,
          colorByteLength: glyphColors?.byteLength ?? 0,
          glyphCount: activeGlyphs.count,
          targetRevision: targetRevision ?? null,
          transformByteLength,
        })
      : null;

    const chunks: Viewport3DGpuUploadChunk[] = batches.map((batch, index) => {
      const batchCount = batch.end - batch.start;
      return {
        estimatedBytes:
          batchCount * 16 * Float32Array.BYTES_PER_ELEMENT * 2,
        itemCount: batchCount,
        upload: () => {
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
        },
        rollback: rollbacks[index],
      };
    });

    uploadManager.enqueue({
      chunks,
      estimatedBytes:
        activeGlyphs.count * 16 * Float32Array.BYTES_PER_ELEMENT * 2,
      key:
        uploadKeys?.matrixKey ??
        `vector-glyph-matrices:${activeGlyphs.count}:${activeGlyphs.directions.byteLength}`,
      lane: "vector-glyph",
      onVisible: () => {
        activeShaft.count = activeGlyphs.count;
        activeHead.count = activeGlyphs.count;
        markVectorGlyphAttributeRange(
          activeShaft.instanceMatrix,
          0,
          activeGlyphs.count,
          16,
        );
        markVectorGlyphAttributeRange(
          activeHead.instanceMatrix,
          0,
          activeGlyphs.count,
          16,
        );
        measureVectorGlyphWork(VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE, startMark);
        measured = true;
        tracker.recordDirtyFrame("vector-glyphs");
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: uploadKeys?.targetRevision ?? null,
    });

    return () => {
      abortController.abort();
      if (!measured) {
        clearVectorGlyphWorkMark(startMark);
      }
    };
  }, [
    buildKey,
    glyphColors,
    glyphTransforms,
    headRef,
    invalidate,
    shaftRef,
    targetRevision,
    tracker,
    transformScratch,
    uploadManager,
  ]);
}

export function VectorFieldLayer({
  buildReference,
  colors,
  colorMode = "orientation",
  opacity = 1,
  segments,
  style,
  materialProfile,
  tracker,
}: {
  buildReference?: Viewport3DVectorBuildReference | null;
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
  const vectorGlyphBuildKey = useMemo(
    () =>
      createVectorGlyphSemanticBuildKey({
        buildReference,
        colorMode,
        headRadiusRatio: resolvedStyle.headRadiusRatio,
        shaftRadiusRatio: resolvedStyle.shaftRadiusRatio,
      }),
    [
      buildReference,
      colorMode,
      resolvedStyle.headRadiusRatio,
      resolvedStyle.shaftRadiusRatio,
    ],
  );
  const glyphBuild = useVectorGlyphBuild({
    buildKey: vectorGlyphBuildKey,
    buildReference,
    colorMode,
    headRadiusRatio: resolvedStyle.headRadiusRatio,
    invalidate,
    segments,
    shaftRadiusRatio: resolvedStyle.shaftRadiusRatio,
    tracker,
  });
  const glyphTransforms = glyphBuild?.transforms ?? null;
  const glyphColors = glyphBuild?.colors ?? null;
  const useInstanceColors = Boolean(glyphColors);
  const glyphCount = glyphTransforms?.count ?? 0;
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
    buildKey: vectorGlyphBuildKey,
    glyphColors,
    glyphCount,
    glyphTransforms,
    headRef,
    instanceColorAttrRef,
    invalidate,
    material,
    materialColor: resolvedStyle.materialColor,
    shaftRef,
    targetRevision: buildReference?.targetRevision ?? null,
    tracker,
    transformScratch,
  });

  if (!glyphTransforms || glyphTransforms.count === 0) return null;

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
