"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { viewport3DVectorLayersEnabledFromBrowserConfig } from "@/kernel/browserFullmagConfig";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { type ThreeEvent, useThree } from "@react-three/fiber";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  memo,
  type RefObject,
} from "react";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DVectorAnchorMode } from "../viewport3dRenderModel";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  resolveSurfacePolicy,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  buildViewport3DFdmInspectSample,
  type Viewport3DInspectSample,
  type Viewport3DInspectScreenPosition,
} from "../viewport3dInspect";
import {
  opacityFromSettings,
  pointColorFromSettings,
  surfaceMaterialColorFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";
import {
  VectorFieldLayer,
  type VectorFieldLayerVectorStyle,
} from "./VectorFieldLayer";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import type { Viewport3DRenderAdoptionReceipt } from "../model/viewport3DRenderAdoptionRegistry";
import {
  eventIntersectsRegionOverlay,
  pickRegionOverlayFromRay,
} from "./regionOverlayPicking";
import {
  buildRegionOverlayModels,
  type RegionOverlayInput,
} from "./regionOverlayModel";
import type { RegionOverlaySelection } from "./RegionOverlayLayer";
import {
  buildFdmVectorSegmentsUncached,
  buildFdmPointPositions,
  type FdmCuboidBuildRequest,
  type FdmCuboidInstanceModel,
  type FdmVoxelTopographyOptions,
} from "./fdmCuboidBuildModel";
import { buildViewport3DFdmCuboidOffMainThread } from "./fdmCuboidBuildScheduler";
import {
  createFdmCuboidBuildStateController,
  EMPTY_FDM_CUBOID_BUILD_SNAPSHOT,
  resolveFdmCuboidBuildState,
  type FdmCuboidBuildState,
} from "./fdmCuboidBuildState";
import { resolveFdmCuboidPassPlan } from "./fdmCuboidPasses";

export {
  buildFdmCuboidInstanceModel,
  buildFdmPointPositions,
  resolveFdmVectorGlyphScale,
  type FdmCuboidInstanceModel,
  type FdmCuboidInstanceModelOptions,
  type FdmVoxelTopographyOptions,
} from "./fdmCuboidBuildModel";

export { resolveFdmCuboidPassPlan } from "./fdmCuboidPasses";
export function hasAnyEffectiveFdmPass(
  settings: Parameters<typeof resolveFdmCuboidPassPlan>[0],
): boolean {
  return resolveFdmCuboidPassPlan(settings).hasAnyEffectivePass;
}

const FDM_INSPECT_PROJECTION_FALLBACK_LIMIT = 5000;
const FDM_INSPECT_PROJECTION_HIT_RADIUS_PX = 36;
const FDM_VECTOR_SEGMENT_CACHE_MAX_ENTRIES_PER_FIELD = 8;
const FDM_VECTOR_SEGMENT_CACHE_MEMORY_BUDGET_ID =
  "viewport3d.render.fdmVectorSegmentCache";

const fdmVectorSegmentCacheCounter = {
  byteLength: 0,
  entryCount: 0,
};

memoryBudgetRegistry.register(FDM_VECTOR_SEGMENT_CACHE_MEMORY_BUDGET_ID, () => ({
  byteLength: fdmVectorSegmentCacheCounter.byteLength,
  category: "render-buffer",
  entryCount: fdmVectorSegmentCacheCounter.entryCount,
  id: FDM_VECTOR_SEGMENT_CACHE_MEMORY_BUDGET_ID,
  label: "FDM vector segment cache",
  maxBytes: null,
}));

const IDENTITY_QUATERNION = new Quaternion();

export const FDM_CUBOID_UPLOAD_BATCH_SIZE = 2048;

export interface FdmCuboidUploadBatch {
  end: number;
  start: number;
}

type FdmUploadTaskHandle = ReturnType<typeof setTimeout>;

export function buildFdmCuboidUploadBatches(
  count: number,
  batchSize = FDM_CUBOID_UPLOAD_BATCH_SIZE,
): FdmCuboidUploadBatch[] {
  const safeCount = Math.max(0, Math.floor(count));
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const batches: FdmCuboidUploadBatch[] = [];

  for (let start = 0; start < safeCount; start += safeBatchSize) {
    batches.push({ end: Math.min(start + safeBatchSize, safeCount), start });
  }

  return batches;
}

function requestFdmUploadTask(callback: () => void): FdmUploadTaskHandle {
  return setTimeout(callback, 0);
}

function cancelFdmUploadTask(handle: FdmUploadTaskHandle): void {
  clearTimeout(handle);
}

function markFdmCuboidUpload(name: string): string | null {
  const target = globalThis.performance;
  if (!target?.mark || !target?.measure) return null;

  const startMark = `${name}:start:${Date.now()}:${Math.random()}`;
  target.mark(startMark);
  return startMark;
}

function measureFdmCuboidUpload(name: string, startMark: string | null): void {
  const target = globalThis.performance;
  if (!startMark || !target?.mark || !target?.measure) return;

  const endMark = `${name}:end:${Date.now()}:${Math.random()}`;
  target.mark(endMark);
  try {
    target.measure(name, startMark, endMark);
  } catch {
    // Gracefully ignore measurement errors
  }
}

type FdmVectorSegmentCache = WeakMap<
  DecodedFieldVector,
  Map<string, Float32Array | null>
>;

const fdmVectorSegmentCache = new WeakMap<
  FdmCuboidInstanceModel,
  FdmVectorSegmentCache
>();

function cachedFdmVectorSegments(
  model: FdmCuboidInstanceModel,
  fieldVector: DecodedFieldVector,
  cacheKey: string,
): Float32Array | null | undefined {
  const fieldCache = fdmVectorSegmentCache.get(model)?.get(fieldVector);
  if (!fieldCache?.has(cacheKey)) return undefined;
  return fieldCache.get(cacheKey) ?? null;
}

function cacheFdmVectorSegments(
  model: FdmCuboidInstanceModel,
  fieldVector: DecodedFieldVector,
  cacheKey: string,
  segments: Float32Array | null,
): void {
  let modelCache = fdmVectorSegmentCache.get(model);
  if (!modelCache) {
    modelCache = new WeakMap();
    fdmVectorSegmentCache.set(model, modelCache);
  }

  let fieldCache = modelCache.get(fieldVector);
  if (!fieldCache) {
    fieldCache = new Map();
    modelCache.set(fieldVector, fieldCache);
  }

  fieldCache.set(cacheKey, segments);
  fdmVectorSegmentCacheCounter.entryCount += 1;
  fdmVectorSegmentCacheCounter.byteLength += fdmVectorSegmentByteLength(segments);
  evictOldestFdmVectorSegmentCacheEntries(fieldCache);
}

function evictOldestFdmVectorSegmentCacheEntries(
  fieldCache: Map<string, Float32Array | null>,
): void {
  while (fieldCache.size > FDM_VECTOR_SEGMENT_CACHE_MAX_ENTRIES_PER_FIELD) {
    const oldestKey = fieldCache.keys().next().value;
    if (oldestKey === undefined) return;
    const value = fieldCache.get(oldestKey);
    fieldCache.delete(oldestKey);
    fdmVectorSegmentCacheCounter.entryCount -= 1;
    fdmVectorSegmentCacheCounter.byteLength -= fdmVectorSegmentByteLength(value);
  }
}

function fdmVectorSegmentByteLength(
  segments: Float32Array | null | undefined,
): number {
  return segments?.byteLength ?? 0;
}

export function buildFdmVectorSegments(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors: number,
  options: { anchorMode?: Viewport3DVectorAnchorMode } = {},
): Float32Array | null {
  if (!model || !fieldVector) return null;
  const anchorMode = options.anchorMode ?? "center";
  const cacheKey = `${scale}:${maxVectors}:${anchorMode}`;
  const cachedSegments = cachedFdmVectorSegments(model, fieldVector, cacheKey);
  if (cachedSegments !== undefined) return cachedSegments;

  const segments = buildFdmVectorSegmentsUncached(
    model,
    fieldVector,
    scale,
    maxVectors,
    options,
  );
  cacheFdmVectorSegments(model, fieldVector, cacheKey, segments);
  return segments;
}

interface FdmInspectProjectionFallbackInput {
  camera: Camera;
  model: FdmCuboidInstanceModel;
  pointerX: number;
  pointerY: number;
  projected: Vector3;
  rectHeight: number;
  rectWidth: number;
}

function resolveProjectedFdmInspectHit({
  camera,
  model,
  pointerX,
  pointerY,
  projected,
  rectHeight,
  rectWidth,
}: FdmInspectProjectionFallbackInput): {
  instanceId: number;
  worldPosition: [number, number, number];
} | null {
  if (model.count > FDM_INSPECT_PROJECTION_FALLBACK_LIMIT) return null;

  const maxDistanceSq =
    FDM_INSPECT_PROJECTION_HIT_RADIUS_PX *
    FDM_INSPECT_PROJECTION_HIT_RADIUS_PX;
  let bestDistanceSq = maxDistanceSq;
  let bestInstanceId = -1;

  for (let instanceId = 0; instanceId < model.count; instanceId += 1) {
    const offset = instanceId * 3;
    const worldX = model.centers[offset] ?? 0;
    const worldY = model.centers[offset + 1] ?? 0;
    const worldZ = model.centers[offset + 2] ?? 0;

    projected.set(worldX, worldY, worldZ).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;

    const screenX = (projected.x * 0.5 + 0.5) * rectWidth;
    const screenY = (-projected.y * 0.5 + 0.5) * rectHeight;
    const dx = screenX - pointerX;
    const dy = screenY - pointerY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq >= bestDistanceSq) continue;

    bestDistanceSq = distanceSq;
    bestInstanceId = instanceId;
  }

  if (bestInstanceId < 0) return null;

  const offset = bestInstanceId * 3;
  return {
    instanceId: bestInstanceId,
    worldPosition: [
      model.centers[offset] ?? 0,
      model.centers[offset + 1] ?? 0,
      model.centers[offset + 2] ?? 0,
    ],
  };
}

interface FdmCuboidMatrixUploadOptions {
  invalidate: () => void;
  model: FdmCuboidInstanceModel | null;
  shaderVisible: boolean;
  surfaceRef: { current: InstancedMesh | null };
  tracker: Viewport3DResourceTracker;
  wireframeRef: { current: InstancedMesh | null };
  wireframeVisible: boolean;
}

function useFdmCuboidMatrixUpload({
  invalidate,
  model,
  shaderVisible,
  surfaceRef,
  tracker,
  wireframeRef,
  wireframeVisible,
}: FdmCuboidMatrixUploadOptions): void {
  useEffect(() => {
    if (!model) return;

    const meshes = [surfaceRef.current, wireframeRef.current].filter(
      (mesh): mesh is InstancedMesh => Boolean(mesh),
    );
    if (meshes.length === 0) return;

    const batches = buildFdmCuboidUploadBatches(model.count);
    if (batches.length === 0) return;

    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3(...model.cellSize);
    const startMark = markFdmCuboidUpload(
      "fullmag.viewport3d.uploadFdmCuboidMatrices",
    );
    let cancelled = false;
    let taskHandle: FdmUploadTaskHandle | null = null;

    const uploadBatch = (batchIndex: number) => {
      if (cancelled) return;

      const batch = batches[batchIndex];
      if (!batch) return;

      for (const mesh of meshes) {
        for (let index = batch.start; index < batch.end; index += 1) {
          const offset = index * 3;
          position.set(
            model.centers[offset] ?? 0,
            model.centers[offset + 1] ?? 0,
            model.centers[offset + 2] ?? 0,
          );
          matrix.compose(position, IDENTITY_QUATERNION, scale);
          mesh.setMatrixAt(index, matrix);
        }
      }

      const nextBatch = batchIndex + 1;
      if (nextBatch < batches.length) {
        taskHandle = requestFdmUploadTask(() => uploadBatch(nextBatch));
        return;
      }

      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
      }
      measureFdmCuboidUpload(
        "fullmag.viewport3d.uploadFdmCuboidMatrices",
        startMark,
      );
      tracker.recordDirtyFrame("fdm-cuboids");
      invalidate();
    };

    uploadBatch(0);

    return () => {
      cancelled = true;
      if (taskHandle !== null) {
        cancelFdmUploadTask(taskHandle);
      }
    };
  }, [
    invalidate,
    model,
    shaderVisible,
    surfaceRef,
    tracker,
    wireframeRef,
    wireframeVisible,
  ]);
}

interface FdmCuboidColorUploadOptions {
  invalidate: () => void;
  model: FdmCuboidInstanceModel | null;
  onAdopted?: () => void;
  surfaceColors: ScalarColorBuffer | null;
  surfaceRef: { current: InstancedMesh | null };
  tracker: Viewport3DResourceTracker;
  usesInstanceColors: boolean;
}

function useFdmCuboidColorUpload({
  invalidate,
  model,
  onAdopted,
  surfaceColors,
  surfaceRef,
  tracker,
  usesInstanceColors,
}: FdmCuboidColorUploadOptions): void {
  useEffect(() => {
    const mesh = surfaceRef.current;
    if (!mesh || !model || !usesInstanceColors || !surfaceColors) return;

    const batches = buildFdmCuboidUploadBatches(model.count);
    if (batches.length === 0) return;

    const color = new Color();
    const startMark = markFdmCuboidUpload(
      "fullmag.viewport3d.uploadFdmCuboidColors",
    );
    let cancelled = false;
    let taskHandle: FdmUploadTaskHandle | null = null;

    const uploadBatch = (batchIndex: number) => {
      if (cancelled) return;

      const batch = batches[batchIndex];
      if (!batch) return;

      for (let index = batch.start; index < batch.end; index += 1) {
        const offset = index * 3;
        color.setRGB(
          surfaceColors.colors[offset] ?? 0,
          surfaceColors.colors[offset + 1] ?? 0,
          surfaceColors.colors[offset + 2] ?? 0,
        );
        mesh.setColorAt(index, color);
      }

      const nextBatch = batchIndex + 1;
      if (nextBatch < batches.length) {
        taskHandle = requestFdmUploadTask(() => uploadBatch(nextBatch));
        return;
      }

      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
      measureFdmCuboidUpload(
        "fullmag.viewport3d.uploadFdmCuboidColors",
        startMark,
      );
      onAdopted?.();
      tracker.recordDirtyFrame("fdm-cuboid-colors");
      invalidate();
    };

    uploadBatch(0);

    return () => {
      cancelled = true;
      if (taskHandle !== null) {
        cancelFdmUploadTask(taskHandle);
      }
    };
  }, [
    invalidate,
    model,
    onAdopted,
    surfaceColors,
    surfaceRef,
    tracker,
    usesInstanceColors,
  ]);
}

export interface FdmCuboidAsyncBuildInput {
  buildKey: string | null;
  domain: FdmGridRenderDomain | null;
  enabled: boolean;
  groupKey: string | null;
  maxVectorGlyphs: number;
  modelFieldVector?: DecodedFieldVector | null;
  realizedRegionIds?: Uint32Array | null;
  revisionSummary: string;
  vectorAnchorMode: Viewport3DVectorAnchorMode;
  vectorField?: DecodedFieldVector | null;
  vectorScale: number;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: FdmVoxelTopographyOptions;
}

export function useFdmCuboidBuildResult({
  buildKey,
  domain,
  enabled,
  groupKey,
  maxVectorGlyphs,
  modelFieldVector,
  realizedRegionIds,
  revisionSummary,
  vectorAnchorMode,
  vectorField,
  vectorScale,
  voxelFillRatio,
  voxelMagnitudeThreshold,
  voxelTopography,
}: FdmCuboidAsyncBuildInput): FdmCuboidBuildState | undefined {
  const store = useMemo(() => createFdmCuboidBuildStateController(), []);
  const request = useMemo<FdmCuboidBuildRequest | null>(
    () =>
      enabled && domain
        ? {
            domain,
            maxVectorGlyphs,
            modelFieldVector,
            realizedRegionIds,
            vectorAnchorMode,
            vectorField,
            vectorScale,
            voxelFillRatio,
            voxelMagnitudeThreshold,
            voxelTopography,
          }
        : null,
    [
      domain,
      enabled,
      maxVectorGlyphs,
      modelFieldVector,
      realizedRegionIds,
      vectorAnchorMode,
      vectorField,
      vectorScale,
      voxelFillRatio,
      voxelMagnitudeThreshold,
      voxelTopography,
    ],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => EMPTY_FDM_CUBOID_BUILD_SNAPSHOT,
  );

  useEffect(() => {
    if (!request || !buildKey) {
      return;
    }

    store.begin(buildKey);
    const abortController = new AbortController();
    void buildViewport3DFdmCuboidOffMainThread(request, {
      buildKey,
      groupKey: groupKey ?? undefined,
      latestWins: true,
      revisionSummary,
      signal: abortController.signal,
    })
      .then((result) => {
        if (abortController.signal.aborted) return;
        store.resolve(buildKey, result);
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        store.reject(buildKey, error);
      });

    return () => {
      abortController.abort();
    };
  }, [buildKey, groupKey, request, revisionSummary, store]);

  if (!request) return undefined;
  return resolveFdmCuboidBuildState({
    currentBuildKey: buildKey,
    snapshot,
  });
}

const FdmCuboidSurfacePass = memo(function FdmCuboidSurfacePass({
  adoptionRegistry,
  colors,
  materialProfile,
  model,
  fieldBufferId,
  onPointerMove,
  onPointerOut,
  renderSettings,
  surfaceColors,
  surfaceRef,
  tracker,
  wireframeRef,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  materialProfile: Viewport3DMaterialProfile;
  model: FdmCuboidInstanceModel;
  fieldBufferId: string | null;
  onPointerMove: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
  renderSettings: VisualizationTargetSettings;
  surfaceColors: ScalarColorBuffer | null;
  surfaceRef: RefObject<InstancedMesh | null>;
  tracker: Viewport3DResourceTracker;
  wireframeRef: RefObject<InstancedMesh | null>;
}) {
  const invalidate = useBatchedInvalidate();
  const geometry = useMemo(
    () => tracker.track("geometry", new BoxGeometry(1, 1, 1)),
    [tracker],
  );
  const surfaceOpacity = opacityFromSettings(renderSettings);
  const surfacePolicy = resolveSurfacePolicy(surfaceOpacity);
  const usesInstanceColors = Boolean(
    surfaceColors && surfaceColors.colors.length === model.count * 3,
  );
  const lastAdoptedSurfaceRef = useRef<{
    fieldBufferId: string | null;
    scalarBuffer: ScalarColorBuffer;
  } | null>(null);
  const recordSurfaceAdoption = useCallback(() => {
    if (!adoptionRegistry || !surfaceColors) return;
    lastAdoptedSurfaceRef.current = { fieldBufferId, scalarBuffer: surfaceColors };
    recordFdmCuboidSurfaceAdoption({
      fieldBufferId,
      registry: adoptionRegistry,
      scalarBuffer: surfaceColors,
    });
  }, [adoptionRegistry, fieldBufferId, surfaceColors]);
  useEffect(() => {
    if (!adoptionRegistry) return;
    const unregister = adoptionRegistry.registerCarrierAdoptionReplay("fdm-domain", () => {
      const adopted = lastAdoptedSurfaceRef.current;
      if (!adopted) return;
      recordFdmCuboidSurfaceAdoption({
        fieldBufferId: adopted.fieldBufferId,
        registry: adoptionRegistry,
        scalarBuffer: adopted.scalarBuffer,
      });
    });
    return () => {
      unregister();
      const adopted = lastAdoptedSurfaceRef.current;
      if (!adopted) return;
      adoptionRegistry.clearAdoption(
        fdmCuboidSurfaceAdoptionIdentity(adopted),
      );
      lastAdoptedSurfaceRef.current = null;
    };
  }, [adoptionRegistry]);
  useEffect(() => {
    if (usesInstanceColors || !adoptionRegistry) return;
    const adopted = lastAdoptedSurfaceRef.current;
    if (!adopted) return;
    adoptionRegistry.clearAdoption(fdmCuboidSurfaceAdoptionIdentity(adopted));
    lastAdoptedSurfaceRef.current = null;
  }, [adoptionRegistry, usesInstanceColors]);
  const surfaceMaterialColor = surfaceMaterialColorFromSettings(
    renderSettings,
    colors.mesh,
    usesInstanceColors,
  );
  const surfaceMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: surfaceMaterialColor,
          opacity: surfaceOpacity,
          vertexColors: usesInstanceColors,
          ...materialProfile.magneticSurface,
          ...surfaceMaterialPolicyProps(surfaceOpacity),
        }),
      ),
    [
      materialProfile.magneticSurface,
      surfaceMaterialColor,
      surfaceOpacity,
      tracker,
      usesInstanceColors,
    ],
  );
  const wireframePolicy = RENDER_POLICIES.featureEdges;
  const wireframeColor = wireframeColorFromSettings(renderSettings, colors.wire);
  const wireframeOpacity = wireframeOpacityFromSettings(
    renderSettings,
    materialProfile.featureEdges,
  );
  const wireframeMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: wireframeColor,
          opacity: wireframeOpacity,
          transparent: wireframePolicy.transparent,
          depthWrite: wireframePolicy.depthWrite,
          depthTest: wireframePolicy.depthTest,
          side: wireframePolicy.side,
          wireframe: true,
        }),
      ),
    [tracker, wireframeColor, wireframeOpacity, wireframePolicy],
  );

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("material", surfaceMaterial),
    [surfaceMaterial, tracker],
  );
  useEffect(
    () => () => tracker.release("material", wireframeMaterial),
    [wireframeMaterial, tracker],
  );

  useFdmCuboidMatrixUpload({
    invalidate,
    model,
    shaderVisible: renderSettings.shaderVisible,
    surfaceRef,
    tracker,
    wireframeRef,
    wireframeVisible: renderSettings.wireframeVisible,
  });
  useFdmCuboidColorUpload({
    invalidate,
    model,
    onAdopted: recordSurfaceAdoption,
    surfaceColors,
    surfaceRef,
    tracker,
    usesInstanceColors,
  });

  return (
    <>
      {renderSettings.shaderVisible ? (
        <instancedMesh
          args={[geometry, surfaceMaterial, model.count]}
          frustumCulled={false}
          key={`fdm-cuboids-surface-${model.count}`}
          onPointerMove={onPointerMove}
          onPointerOut={onPointerOut}
          ref={surfaceRef}
          renderOrder={surfacePolicy.renderOrder}
        />
      ) : null}
      {renderSettings.wireframeVisible ? (
        <instancedMesh
          args={[geometry, wireframeMaterial, model.count]}
          frustumCulled={false}
          key={`fdm-cuboids-wire-${model.count}`}
          onPointerMove={onPointerMove}
          onPointerOut={onPointerOut}
          ref={wireframeRef}
          renderOrder={wireframePolicy.renderOrder}
        />
      ) : null}
    </>
  );
});

const FdmCuboidPointsPass = memo(function FdmCuboidPointsPass({
  colors,
  model,
  renderSettings,
  tracker,
}: {
  colors: Viewport3DColors;
  model: FdmCuboidInstanceModel;
  renderSettings: VisualizationTargetSettings;
  tracker: Viewport3DResourceTracker;
}) {
  const geometry = useMemo(() => {
    const positions = buildFdmPointPositions(model, renderSettings.geometryScope);
    if (!positions) return null;
    return tracker.track(
      "geometry",
      new BufferGeometry().setAttribute(
        "position",
        new BufferAttribute(positions, 3),
      ),
    );
  }, [model, renderSettings.geometryScope, tracker]);
  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );
  if (!geometry) return null;
  return (
    <points
      geometry={geometry}
      renderOrder={RENDER_POLICIES.points.renderOrder}
    >
      <pointsMaterial
        color={pointColorFromSettings(renderSettings, colors.wire)}
        opacity={opacityFromSettings(renderSettings)}
        sizeAttenuation={false}
        size={3}
        {...materialPolicyProps("points")}
      />
    </points>
  );
});

export const FdmCuboidLayer = memo(function FdmCuboidLayer({
  adoptionRegistry,
  colors,
  materialProfile,
  onSelectDomain,
  onSelectRegion,
  regionOverlays,
  settings,
  selectedObjectId,
  selectedRegionId,
  surfaceColors,
  tracker,
  vectorColorMode,
  vectorStyle,
  fieldVector,
  instanceModel,
  inspectEnabled,
  inspectQuantityId,
  onInspectClear,
  onInspectSample,
  vectorSegments,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  fieldVector: DecodedFieldVector | null | undefined;
  instanceModel?: FdmCuboidInstanceModel | null;
  inspectEnabled: boolean;
  inspectQuantityId: string;
  materialProfile: Viewport3DMaterialProfile;
  onInspectClear?: () => void;
  onInspectSample?: (
    sample: Viewport3DInspectSample,
    screenPosition: Viewport3DInspectScreenPosition,
  ) => void;
  onSelectDomain: () => void;
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  regionOverlays?: readonly RegionOverlayInput[];
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  settings: VisualizationTargetSettings;
  surfaceColors: ScalarColorBuffer | null;
  tracker: Viewport3DResourceTracker;
  vectorColorMode: string;
  vectorSegments: Float32Array | null;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const surfaceRef = useRef<InstancedMesh>(null);
  const wireframeRef = useRef<InstancedMesh>(null);
  const { camera, gl } = useThree();
  const inspectRaycastState = useMemo(
    () => ({
      pointer: new Vector2(),
      projected: new Vector3(),
      raycaster: new Raycaster(),
    }),
    [],
  );
  const inspectFrameRef = useRef(0);
  const r3fInspectHitFrameRef = useRef(0);
  const renderSettings = settings;
  const passPlan = resolveFdmCuboidPassPlan(renderSettings);
  const regionPickModels = useMemo(
    () =>
      buildRegionOverlayModels(regionOverlays ?? [], {
        selectedObjectId,
        selectedRegionId,
      }),
    [regionOverlays, selectedObjectId, selectedRegionId],
  );
  const model = instanceModel ?? null;
  useEffect(() => {
    if (!inspectEnabled || !model) return undefined;

    const canvas = gl.domElement;
    let cachedRect = canvas.getBoundingClientRect();
    let pendingEvent: PointerEvent | null = null;
    let pendingFrame = 0;
    let rafId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      cachedRect = canvas.getBoundingClientRect();
    });

    const processInspectPointerMove = (event: PointerEvent) => {
      const rect = cachedRect;
      if (rect.width <= 0 || rect.height <= 0) return;

      inspectRaycastState.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      inspectRaycastState.raycaster.setFromCamera(
        inspectRaycastState.pointer,
        camera,
      );

      const targets = [surfaceRef.current, wireframeRef.current].filter(
        (mesh): mesh is InstancedMesh => Boolean(mesh),
      );
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const hit = inspectRaycastState.raycaster
        .intersectObjects(targets, false)
        .find((intersection) => typeof intersection.instanceId === "number");

      const fallbackHit = hit
        ? null
        : resolveProjectedFdmInspectHit({
            camera,
            model,
            pointerX,
            pointerY,
            projected: inspectRaycastState.projected,
            rectHeight: rect.height,
            rectWidth: rect.width,
          });
      const instanceId = hit?.instanceId ?? fallbackHit?.instanceId;
      const worldPosition: [number, number, number] | null = hit
        ? [hit.point.x, hit.point.y, hit.point.z]
        : (fallbackHit?.worldPosition ?? null);

      if (typeof instanceId !== "number" || !worldPosition) {
        onInspectClear?.();
        return;
      }

      onInspectSample?.(
        buildViewport3DFdmInspectSample({
          fieldVector,
          instanceId,
          model,
          quantityId: inspectQuantityId,
          worldPosition,
        }),
        {
          x: pointerX,
          y: pointerY,
        },
      );
    };
    const handleInspectPointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) return;

      pendingEvent = event;
      inspectFrameRef.current += 1;
      pendingFrame = inspectFrameRef.current;
      if (rafId !== null) return;

      rafId = requestAnimationFrame(() => {
        rafId = null;
        const eventToProcess = pendingEvent;
        const eventFrame = pendingFrame;
        pendingEvent = null;
        if (!eventToProcess) return;
        if (r3fInspectHitFrameRef.current === eventFrame) return;
        processInspectPointerMove(eventToProcess);
      });
    };
    const handleInspectPointerLeave = () => {
      pendingEvent = null;
      onInspectClear?.();
    };

    resizeObserver.observe(canvas);
    canvas.addEventListener("pointermove", handleInspectPointerMove, {
      passive: true,
    });
    canvas.addEventListener("pointerleave", handleInspectPointerLeave, {
      passive: true,
    });
    return () => {
      canvas.removeEventListener("pointermove", handleInspectPointerMove);
      canvas.removeEventListener("pointerleave", handleInspectPointerLeave);
      resizeObserver.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    camera,
    fieldVector,
    gl,
    inspectEnabled,
    inspectQuantityId,
    inspectRaycastState,
    model,
    onInspectClear,
    onInspectSample,
  ]);

  if (
    !model ||
    !renderSettings.visible ||
    !passPlan.needsCellModel
  ) {
    return null;
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
    const pickedRegion = pickRegionOverlayFromRay(event.ray, regionPickModels);
    if (pickedRegion) {
      event.stopPropagation();
      onSelectRegion?.(pickedRegion);
      return;
    }
    onSelectDomain();
  };
  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!inspectEnabled) return;
    event.stopPropagation();
    r3fInspectHitFrameRef.current = inspectFrameRef.current;
    onInspectSample?.(
      buildViewport3DFdmInspectSample({
        fieldVector,
        instanceId: event.instanceId,
        model,
        quantityId: inspectQuantityId,
        worldPosition: [event.point.x, event.point.y, event.point.z],
      }),
      {
        x: event.nativeEvent.offsetX,
        y: event.nativeEvent.offsetY,
      },
    );
  };
  const handlePointerOut = () => {
    if (!inspectEnabled) return;
    onInspectClear?.();
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {passPlan.needsSurfaceInstances ? (
        <FdmCuboidSurfacePass
          adoptionRegistry={adoptionRegistry}
          colors={colors}
          materialProfile={materialProfile}
          fieldBufferId={
            fieldVector
              ? `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`
              : null
          }
          model={model}
          onPointerMove={handlePointerMove}
          onPointerOut={handlePointerOut}
          renderSettings={renderSettings}
          surfaceColors={surfaceColors}
          surfaceRef={surfaceRef}
          tracker={tracker}
          wireframeRef={wireframeRef}
        />
      ) : null}
      {passPlan.needsPointGeometry ? (
        <FdmCuboidPointsPass
          colors={colors}
          model={model}
          renderSettings={renderSettings}
          tracker={tracker}
        />
      ) : null}
      {viewport3DVectorLayersEnabledFromBrowserConfig() &&
      passPlan.needsVectors ? (
        <VectorFieldLayer
          adoptionRegistry={adoptionRegistry}
          carrierId="fdm-domain"
          colors={colors}
          colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={opacityFromSettings(renderSettings)}
          fieldBufferId={
            fieldVector
              ? `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`
              : null
          }
          segments={vectorSegments}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
});

export function recordFdmCuboidSurfaceAdoption({
  fieldBufferId,
  registry,
  scalarBuffer,
}: {
  fieldBufferId: string | null;
  registry: Viewport3DRenderAdoptionRegistry;
  scalarBuffer: ScalarColorBuffer;
}): Omit<Viewport3DRenderAdoptionReceipt, "byteLength" | "targetId"> {
  const adoption = fdmCuboidSurfaceAdoptionIdentity({
    fieldBufferId,
    scalarBuffer,
  });
  registry.recordSurfaceAdoption({
    byteLength:
      scalarBuffer.colors.byteLength +
      (scalarBuffer.scalarValues?.byteLength ?? 0),
    carrierId: adoption.carrierId,
    fieldBufferId: adoption.fieldBufferId,
    resourceKey: adoption.resourceKey,
    scalarBufferKey: adoption.scalarBufferKey ?? "unknown",
  });
  return adoption;
}

function fdmCuboidSurfaceAdoptionIdentity({
  fieldBufferId,
  scalarBuffer,
}: {
  fieldBufferId: string | null;
  scalarBuffer: ScalarColorBuffer;
}): Omit<Viewport3DRenderAdoptionReceipt, "byteLength" | "targetId"> {
  return {
    carrierId: "fdm-domain",
    fieldBufferId: scalarBuffer.sourceFieldBufferId ?? fieldBufferId,
    kind: "surface",
    resourceKey: scalarBuffer.sourceResourceKey ?? null,
    scalarBufferKey:
      scalarBuffer.buildKey ??
      `scalar:${scalarBuffer.quantityId ?? "unknown"}:${scalarBuffer.colorMode ?? "unknown"}:${scalarBuffer.colors.byteLength}`,
    vectorBuildKey: null,
  };
}
