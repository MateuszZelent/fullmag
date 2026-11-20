import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { resolveViewport3DScalarColorBufferKey, type ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DRenderAdoptionIdentity } from "../model/viewport3DRenderAdoptionRegistry";
import { buildViewport3DFdmCuboidOffMainThread } from "./fdmCuboidBuildScheduler";
import { buildFdmVectorSegmentsUncached, resolveFdmCuboidMembershipRevision, type FdmCuboidBuildRequest, type FdmCuboidBuildResult, type FdmCuboidCellSelection, type FdmCuboidInstanceModel, type FdmVectorOnlyBuildInput, type FdmVoxelTopographyOptions } from "./fdmCuboidBuildModel";
import { mergeFdmCuboidBuildResult, type FdmCuboidBuildState } from "./fdmCuboidBuildState";
import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { Viewport3DVectorAnchorMode } from "../viewport3dRenderModel";
import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh } from "three";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { recordVisualizationDebugPerformanceMetric } from "@/kernel/performance/visualizationDebugPerformanceProbe";
import { resolveFdmCuboidPassPlan } from "./fdmCuboidPasses";

export function hasAnyEffectiveFdmPass(
  settings: Parameters<typeof resolveFdmCuboidPassPlan>[0],
): boolean {
  return resolveFdmCuboidPassPlan(settings).hasAnyEffectivePass;
}

const FDM_VECTOR_SEGMENT_CACHE_MAX_ENTRIES_PER_FIELD = 8;

export const FDM_VECTOR_SEGMENT_CACHE_MAX_BYTES_PER_FIELD = 32 * 1024 * 1024;

export const fdmVectorSegmentCacheCounter = {
  byteLength: 0,
  entryCount: 0,
};

export const FDM_CUBOID_UPLOAD_BATCH_SIZE = 2048;

export interface FdmCuboidUploadBatch {
  end: number;
  start: number;
}

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

export function buildFdmCuboidColorUploadBatchesForView(
  model: Pick<FdmCuboidInstanceModel, "count">,
  instanceOrdinals?: Uint32Array | null,
  batchSize = FDM_CUBOID_UPLOAD_BATCH_SIZE,
): FdmCuboidUploadBatch[] {
  return buildFdmCuboidUploadBatches(
    instanceOrdinals?.length ?? model.count,
    batchSize,
  );
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
  if (!fieldCache?.has(cacheKey)) {
    recordVisualizationDebugPerformanceMetric("cacheMisses");
    return undefined;
  }
  recordVisualizationDebugPerformanceMetric("cacheHits");
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
  maxEntries = FDM_VECTOR_SEGMENT_CACHE_MAX_ENTRIES_PER_FIELD,
  maxBytes = FDM_VECTOR_SEGMENT_CACHE_MAX_BYTES_PER_FIELD,
): void {
  let fieldCacheBytes = Array.from(fieldCache.values()).reduce(
    (total, value) => total + fdmVectorSegmentByteLength(value),
    0,
  );
  while (
    fieldCache.size > maxEntries ||
    fieldCacheBytes > maxBytes
  ) {
    const oldestKey = fieldCache.keys().next().value;
    if (oldestKey === undefined) return;
    const value = fieldCache.get(oldestKey);
    fieldCache.delete(oldestKey);
    recordVisualizationDebugPerformanceMetric("cacheEvictions");
    fieldCacheBytes -= fdmVectorSegmentByteLength(value);
    fdmVectorSegmentCacheCounter.entryCount -= 1;
    fdmVectorSegmentCacheCounter.byteLength -= fdmVectorSegmentByteLength(value);
  }
}

export function evictFdmVectorSegmentCacheEntriesForTests(
  fieldCache: Map<string, Float32Array | null>,
  maxEntries: number,
  maxBytes: number,
): void {
  evictOldestFdmVectorSegmentCacheEntries(fieldCache, maxEntries, maxBytes);
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
  options: {
    anchorMode?: Viewport3DVectorAnchorMode;
    cellSelection?: FdmCuboidCellSelection;
    geometryScope?: "surface" | "full";
    instanceOrdinals?: Uint32Array | null;
    realizedRegionIds?: Uint32Array | null;
    vectorLengthScale?: number;
    surfaceOffsetEnabled?: boolean;
    surfaceOffsetScale?: number;
  } = {},
): Float32Array | null {
  if (!model || !fieldVector) return null;
  if (options.instanceOrdinals) {
    return buildFdmVectorSegmentsUncached(
      model,
      fieldVector,
      scale,
      maxVectors,
      options,
    );
  }
  const anchorMode = options.anchorMode ?? "center";
  const cacheKey = `${scale}:${maxVectors}:${options.vectorLengthScale ?? "scale"}:${anchorMode}:${options.geometryScope ?? "full"}:${options.surfaceOffsetEnabled === true}:${options.surfaceOffsetScale ?? 0}`;
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

export function resolveFdmCuboidSourceInstanceOrdinal(
  renderedInstanceId: number,
  instanceOrdinals: Uint32Array | null | undefined,
  sourceCount: number,
): number | null {
  if (!Number.isInteger(renderedInstanceId) || renderedInstanceId < 0) return null;
  const sourceInstance = instanceOrdinals
    ? instanceOrdinals[renderedInstanceId]
    : renderedInstanceId;
  if (sourceInstance === undefined) return null;
  return sourceInstance < sourceCount ? sourceInstance : null;
}

export function resolveFdmCuboidGeometryScopeInstanceOrdinals(
  geometryScope: "surface" | "full",
  instanceOrdinals: Uint32Array | null | undefined,
  surfaceInstanceOrdinals: Uint32Array | null | undefined,
): Uint32Array | null | undefined {
  if (geometryScope === "surface" && surfaceInstanceOrdinals !== null && surfaceInstanceOrdinals !== undefined) {
    return surfaceInstanceOrdinals;
  }
  return instanceOrdinals;
}

export function fdmCuboidSurfaceMeshKey(
  modelCount: number,
  usesInstanceColors: boolean,
): string {
  return `fdm-cuboids-surface-${modelCount}-${usesInstanceColors ? "field-colors" : "uniform-color"}`;
}

export function fdmCuboidUsesInstanceColors(
  settings: Pick<VisualizationTargetSettings, "surfaceColorSource">,
  surfaceColors: ScalarColorBuffer | null,
  renderCount: number,
): boolean {
  return (
    settings.surfaceColorSource !== "solid" &&
    Boolean(surfaceColors && surfaceColors.colors.length === renderCount * 3)
  );
}

export interface FdmCuboidPreparedInstances {
  cellIndices: Uint32Array;
  contentRevision: string;
  count: number;
  matrices: Float32Array;
  membershipRevision: string;
  ordinals: Uint32Array;
}

export function estimateFdmCuboidCarrierPeakBytes(count: number): number {
  const safeCount = Math.max(0, Math.floor(count));
  const preparedMatrices = safeCount * 16 * Float32Array.BYTES_PER_ELEMENT;
  const twoCpuMatrixAttributes = preparedMatrices * 2;
  const twoGpuMatrixBuffers = preparedMatrices * 2;
  const centersAndMembership =
    safeCount * (3 * Float32Array.BYTES_PER_ELEMENT + 2 * Uint32Array.BYTES_PER_ELEMENT);
  const sourceAndCarrierColors = safeCount * 6 * Float32Array.BYTES_PER_ELEMENT;
  const targetLocalPreparedMatrices = preparedMatrices;
  return (
    preparedMatrices +
    twoCpuMatrixAttributes +
    twoGpuMatrixBuffers +
    centersAndMembership +
    sourceAndCarrierColors +
    targetLocalPreparedMatrices
  );
}

export function prepareFdmCuboidInstanceMatrices(
  model: FdmCuboidInstanceModel,
  instanceOrdinals: Uint32Array | null | undefined,
  revisionSeed = "fdm-cuboids",
): FdmCuboidPreparedInstances {
  const count = instanceOrdinals?.length ?? model.count;
  const ordinals = instanceOrdinals
    ? new Uint32Array(instanceOrdinals)
    : Uint32Array.from({ length: count }, (_, index) => index);
  const cellIndices = new Uint32Array(count);
  const matrices = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const sourceInstance = ordinals[index] ?? 0;
    const cellIndex = model.cellIndices[sourceInstance] ?? 0;
    cellIndices[index] = cellIndex;
    matrices.set(
      model.matrices.subarray(sourceInstance * 16, sourceInstance * 16 + 16),
      index * 16,
    );
  }
  const membershipContentRevision = resolveFdmCuboidMembershipRevision(cellIndices);
  const membershipRevision = `${revisionSeed}:${membershipContentRevision}`;
  return {
    cellIndices,
    contentRevision: `${revisionSeed}:${model.matrixContentRevision}:${membershipContentRevision.slice("membership:".length)}`,
    count,
    matrices,
    membershipRevision,
    ordinals,
  };
}

export function resolveFdmCuboidColorUploadRevision(
  prepared: Pick<FdmCuboidPreparedInstances, "membershipRevision">,
  surfaceColors: ScalarColorBuffer,
): string {
  return `${prepared.membershipRevision}:${resolveViewport3DScalarColorBufferKey(surfaceColors)}`;
}

export function resolveFdmCuboidPreparedSourceOrdinal(
  prepared: Pick<
    FdmCuboidPreparedInstances,
    "cellIndices" | "count" | "ordinals"
  >,
  renderedInstanceId: number,
): number | null {
  if (
    !Number.isInteger(renderedInstanceId) ||
    renderedInstanceId < 0 ||
    renderedInstanceId >= prepared.count ||
    renderedInstanceId >= prepared.cellIndices.length
  ) {
    return null;
  }
  return prepared.ordinals[renderedInstanceId] ?? null;
}

export function visibleFdmCuboidInspectTargets(
  meshes: readonly (InstancedMesh | null)[],
): InstancedMesh[] {
  return meshes.filter(
    (mesh): mesh is InstancedMesh => Boolean(mesh?.visible),
  );
}

export function shouldAttachFdmCuboidInspectListener({
  inspectEnabled,
  prepared,
  surfaceVisible,
  targetVisible,
  wireframeVisible,
}: {
  inspectEnabled: boolean;
  prepared: boolean;
  surfaceVisible: boolean;
  targetVisible: boolean;
  wireframeVisible: boolean;
}): boolean {
  return (
    inspectEnabled &&
    prepared &&
    targetVisible &&
    (surfaceVisible || wireframeVisible)
  );
}

export function createFdmInspectClearArbitrator({
  cancelFrame,
  onClear,
  requestFrame,
}: {
  cancelFrame: (frame: number) => void;
  onClear: () => void;
  requestFrame: (callback: FrameRequestCallback) => number;
}): {
  clear: () => void;
  dispose: () => void;
  sample: () => void;
} {
  let clearFrame: number | null = null;
  let sampleProtectionFrame: number | null = null;

  const cancelClear = () => {
    if (clearFrame === null) return;
    cancelFrame(clearFrame);
    clearFrame = null;
  };
  const clear = () => {
    if (sampleProtectionFrame !== null || clearFrame !== null) return;
    clearFrame = requestFrame(() => {
      clearFrame = null;
      onClear();
    });
  };
  const sample = () => {
    cancelClear();
    if (sampleProtectionFrame !== null) {
      cancelFrame(sampleProtectionFrame);
    }
    sampleProtectionFrame = requestFrame(() => {
      sampleProtectionFrame = null;
    });
  };
  const dispose = () => {
    cancelClear();
    if (sampleProtectionFrame !== null) {
      cancelFrame(sampleProtectionFrame);
      sampleProtectionFrame = null;
    }
  };
  return { clear, dispose, sample };
}

export function uploadFdmCuboidAttribute(
  attribute: InstancedBufferAttribute,
  source: Float32Array,
  contentRevision: string,
  uploadedRevision: string | null,
): string {
  if (uploadedRevision === contentRevision) return uploadedRevision;
  if (attribute.array.length !== source.length) {
    throw new Error("FDM cuboid attribute capacity does not match payload");
  }
  (attribute.array as Float32Array).set(source);
  attribute.setUsage(DynamicDrawUsage);
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, source.length);
  attribute.needsUpdate = true;
  return contentRevision;
}

export function disposeFdmCuboidInstanceColorBeforeReplace(
  mesh: InstancedMesh,
  nextInstanceColor: InstancedBufferAttribute | null,
): void {
  if (
    mesh.instanceColor === null ||
    mesh.instanceColor === nextInstanceColor
  ) {
    return;
  }
  // Three.js releases instance attributes and their binding states on mesh
  // disposal. Keep the old color attached until those owners have released it.
  mesh.dispose();
}

export function handleFdmCuboidContextLost(
  event: Event,
  invalidateUploadedRevisions: () => void,
): void {
  event.preventDefault();
  invalidateUploadedRevisions();
}

export interface FdmCuboidAsyncBuildInput {
  buildKey: string | null;
  cellSelection: FdmCuboidCellSelection;
  domain: FdmGridRenderDomain | null;
  enabled: boolean;
  groupKey: string | null;
  maxVectorGlyphs: number;
  modelFieldVector?: DecodedFieldVector | null;
  nativeActiveMask?: Uint8Array | null;
  realizedRegionIds: Uint32Array | null;
  revisionSummary: string;
  /** Stable carrier/grid identity used to retain a last-good model. */
  topologyKey?: string | null;
  /** Optional bounded anchor carrier for a vectors-only build. */
  vectorOnly?: FdmVectorOnlyBuildInput | null;
  vectorAnchorMode: Viewport3DVectorAnchorMode;
  vectorField?: DecodedFieldVector | null;
  vectorGeometryScope?: "full" | "surface";
  vectorLengthScale?: number;
  vectorScale: number;
  vectorSurfaceOffsetEnabled?: boolean;
  vectorSurfaceOffsetScale?: number;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: FdmVoxelTopographyOptions;
}

export interface FdmCuboidAsyncBuildEntry extends FdmCuboidAsyncBuildInput {
  id: string;
}

interface FdmCuboidBuildResultsController {
  begin: (entries: readonly FdmCuboidAsyncBuildEntry[]) => void;
  getSnapshot: () => ReadonlyMap<string, FdmCuboidBuildState>;
  reject: (id: string, buildKey: string, error: unknown) => void;
  resolve: (id: string, buildKey: string, result: FdmCuboidBuildResult) => void;
  subscribe: (listener: () => void) => () => void;
}

export const EMPTY_FDM_CUBOID_BUILD_RESULTS = new Map<string, FdmCuboidBuildState>();

function createFdmCuboidBuildResultsController(): FdmCuboidBuildResultsController {
  let snapshot: ReadonlyMap<string, FdmCuboidBuildState> =
    EMPTY_FDM_CUBOID_BUILD_RESULTS;
  const topologyKeys = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, FdmCuboidBuildState>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const begin = (entries: readonly FdmCuboidAsyncBuildEntry[]) => {
    const next = new Map(
      entries.flatMap((entry) => {
        if (!entry.enabled || !entry.buildKey) return [];
        const previous = snapshot.get(entry.id);
        const previousTopologyKey = topologyKeys.get(entry.id) ?? null;
        const topologyKey = entry.topologyKey ?? null;
        topologyKeys.set(entry.id, topologyKey);
        const retainLastGood =
          previous?.result !== null &&
          previousTopologyKey !== null &&
          topologyKey !== null &&
          previousTopologyKey === topologyKey;
        return [[
          entry.id,
          previous?.buildKey === entry.buildKey
            ? previous
            : {
                buildKey: entry.buildKey,
                error: null,
                result: retainLastGood ? previous?.result ?? null : null,
                status: "pending" as const,
              },
        ] as const];
      }),
    );
    if (
      next.size === snapshot.size &&
      [...next].every(([id, state]) => snapshot.get(id) === state)
    ) {
      return;
    }
    publish(next);
  };
  return {
    begin,
    getSnapshot: () => snapshot,
    reject: (id, buildKey, error) => {
      const current = snapshot.get(id);
      if (!current || current.buildKey !== buildKey) return;
      if (error instanceof Error && error.name === "AbortError") return;
      publish(new Map(snapshot).set(id, {
        buildKey,
        error: error instanceof Error ? error : new Error(String(error)),
        result: current.result,
        status: "error",
      }));
    },
    resolve: (id, buildKey, result) => {
      const current = snapshot.get(id);
      if (!current || current.buildKey !== buildKey) return;
      publish(new Map(snapshot).set(id, {
        buildKey,
        error: null,
        result: mergeFdmCuboidBuildResult(current.result, result),
        status: "ready",
      }));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface FdmCuboidBatchBuildController {
  dispose: () => void;
  getActiveBuildCount: () => number;
  getSnapshot: () => ReadonlyMap<string, FdmCuboidBuildState>;
  reconcile: (entries: readonly FdmCuboidAsyncBuildEntry[]) => void;
  subscribe: (listener: () => void) => () => void;
}

type FdmCuboidBatchBuild = (
  request: FdmCuboidBuildRequest,
  options: Parameters<typeof buildViewport3DFdmCuboidOffMainThread>[1],
) => Promise<FdmCuboidBuildResult>;

export function createFdmCuboidBatchBuildController(
  build: FdmCuboidBatchBuild = buildViewport3DFdmCuboidOffMainThread,
): FdmCuboidBatchBuildController {
  const store = createFdmCuboidBuildResultsController();
  const activeBuilds = new Map<
    string,
    { buildKey: string; controller: AbortController }
  >();

  const reconcile = (entries: readonly FdmCuboidAsyncBuildEntry[]) => {
    const activeEntries = entries.filter(
      (entry): entry is FdmCuboidAsyncBuildEntry & { buildKey: string } =>
        entry.enabled && Boolean(entry.domain) && Boolean(entry.buildKey),
    );
    const activeEntriesById = new Map<string, FdmCuboidAsyncBuildEntry>();
    for (const entry of activeEntries) {
      if (!activeEntriesById.has(entry.id)) activeEntriesById.set(entry.id, entry);
    }
    store.begin(activeEntries);
    for (const [id, active] of activeBuilds) {
      const next = activeEntriesById.get(id);
      if (!next || next.buildKey !== active.buildKey) {
        active.controller.abort();
        activeBuilds.delete(id);
      }
    }
    for (const entry of activeEntries) {
      if (activeBuilds.get(entry.id)?.buildKey === entry.buildKey) continue;
      if (
        store.getSnapshot().get(entry.id)?.buildKey === entry.buildKey &&
        store.getSnapshot().get(entry.id)?.status === "ready"
      ) {
        continue;
      }
      const abortController = new AbortController();
      activeBuilds.set(entry.id, {
        buildKey: entry.buildKey,
        controller: abortController,
      });
      const request: FdmCuboidBuildRequest = {
        cellSelection: entry.cellSelection,
        domain: entry.domain,
        maxVectorGlyphs: entry.maxVectorGlyphs,
        modelFieldVector: entry.modelFieldVector,
        nativeActiveMask: entry.nativeActiveMask,
        realizedRegionIds: entry.realizedRegionIds,
        vectorAnchorMode: entry.vectorAnchorMode,
        vectorField: entry.vectorField,
        vectorGeometryScope: entry.vectorGeometryScope,
        vectorLengthScale: entry.vectorLengthScale,
        vectorOnly: entry.vectorOnly,
        vectorScale: entry.vectorScale,
        vectorSurfaceOffsetEnabled: entry.vectorSurfaceOffsetEnabled,
        vectorSurfaceOffsetScale: entry.vectorSurfaceOffsetScale,
        voxelFillRatio: entry.voxelFillRatio,
        voxelMagnitudeThreshold: entry.voxelMagnitudeThreshold,
        voxelTopography: entry.voxelTopography,
      };
      void build(request, {
        buildKey: entry.buildKey,
        groupKey: entry.groupKey ?? undefined,
        latestWins: true,
        revisionSummary: entry.revisionSummary,
        signal: abortController.signal,
      }).then(
        (result) => {
          if (!abortController.signal.aborted) {
            store.resolve(entry.id, entry.buildKey, result);
          }
          if (activeBuilds.get(entry.id)?.buildKey === entry.buildKey) {
            activeBuilds.delete(entry.id);
          }
        },
        (error: unknown) => {
          if (!abortController.signal.aborted) {
            store.reject(entry.id, entry.buildKey, error);
          }
          if (activeBuilds.get(entry.id)?.buildKey === entry.buildKey) {
            activeBuilds.delete(entry.id);
          }
        },
      );
    }
  };

  return {
    dispose: () => {
      for (const active of activeBuilds.values()) active.controller.abort();
      activeBuilds.clear();
      store.begin([]);
    },
    getActiveBuildCount: () => activeBuilds.size,
    getSnapshot: store.getSnapshot,
    reconcile,
    subscribe: store.subscribe,
  };
}

export function fdmCuboidVectorPassCanRenderWithoutCellModel({
  targetVisible,
  vectorsEnabled,
  vectorsVisible,
  vectorSegments,
}: {
  targetVisible: boolean;
  vectorsEnabled: boolean;
  vectorsVisible: boolean;
  vectorSegments: Float32Array | null;
}): boolean {
  return Boolean(
    targetVisible &&
      vectorsEnabled &&
      vectorsVisible &&
      (vectorSegments?.length ?? 0) > 0,
  );
}

export function recordFdmCuboidSurfaceAdoption({
  carrierId = "fdm-domain",
  fieldBufferId,
  ownerId,
  registry,
  sessionIdentity,
  scalarBuffer,
}: {
  carrierId?: string;
  fieldBufferId: string | null;
  ownerId?: string;
  registry: Viewport3DRenderAdoptionRegistry;
  sessionIdentity?: SessionResourceIdentity | null;
  scalarBuffer: ScalarColorBuffer;
}): Viewport3DRenderAdoptionIdentity {
  const adoption = fdmCuboidSurfaceAdoptionIdentity({
    carrierId,
    fieldBufferId,
    scalarBuffer,
  });
  registry.recordSurfaceAdoption({
    byteLength:
      scalarBuffer.colors.byteLength +
      (scalarBuffer.scalarValues?.byteLength ?? 0),
    carrierId: adoption.carrierId,
    fieldBufferId: adoption.fieldBufferId,
    ownerId,
    resourceKey: adoption.resourceKey,
    sessionIdentity,
    scalarBufferKey: adoption.scalarBufferKey ?? "unknown",
  });
  return adoption;
}

export function fdmCuboidSurfaceAdoptionIdentity({
  carrierId = "fdm-domain",
  fieldBufferId,
  scalarBuffer,
}: {
  carrierId?: string;
  fieldBufferId: string | null;
  scalarBuffer: ScalarColorBuffer;
}): Viewport3DRenderAdoptionIdentity {
  return {
    carrierId,
    fieldBufferId: scalarBuffer.sourceFieldBufferId ?? fieldBufferId,
    kind: "surface",
    resourceKey: scalarBuffer.sourceResourceKey ?? null,
    scalarBufferKey: resolveViewport3DScalarColorBufferKey(scalarBuffer),
    vectorBuildKey: null,
  };
}
