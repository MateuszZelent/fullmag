/**
 * Cache layer for FEM slice results.
 *
 * Separates topology (geometry) from field sampling so that:
 * - changing the component or quantity does **not** recompute topology,
 * - changing the colour scale does **not** recompute anything,
 * - only changing the plane/position/thickness invalidates the topology.
 *
 * The cache key is derived from the subset of FemSliceQuery fields that
 * affect each level.
 */

import type { FemSliceQuery } from "./femSliceQuery";
import type {
  ProjectionResult,
  SliceCollection,
  SliceTopologyCollection,
} from "./femSliceGeometry";
import { updateFrontendResourceBucket } from "@/lib/debug/frontendResourceManager";

const objectIdentityMap = new WeakMap<object, number>();
let nextObjectIdentity = 1;

function objectIdentity(value: object | null | undefined): number {
  if (!value) {
    return 0;
  }
  const existing = objectIdentityMap.get(value);
  if (existing) {
    return existing;
  }
  const created = nextObjectIdentity++;
  objectIdentityMap.set(value, created);
  return created;
}

export interface FemSliceCacheContext {
  planeWorldCoord: number;
  meshNodes?: object | null;
  meshElements?: object | null;
  meshBoundaryFaces?: object | null;
  visibleElements?: object | null;
  visibleBoundaryFaces?: object | null;
  visiblePartIds?: Iterable<string>;
  boundsStrategy?: string;
  fieldX?: object | null;
  fieldY?: object | null;
  fieldZ?: object | null;
  fieldRevision?: string | number | null;
  fieldNComp?: number | null;
}

function visiblePartsFingerprint(value: Iterable<string> | undefined): string {
  if (!value) {
    return "";
  }
  return Array.from(value).sort().join(",");
}

export type SliceCacheState = "hit" | "miss";

const MAX_TOPOLOGY_CACHE_ENTRIES = 18;
const MAX_FIELD_CACHE_ENTRIES = 48;
const MAX_TOPOLOGY_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_FIELD_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_PROJECTION_CACHE_ENTRIES = 24;
const MAX_PROJECTION_CACHE_BYTES = 96 * 1024 * 1024;

function getLruValue<T>(cache: Map<string, T>, key: string): T | null {
  const existing = cache.get(key);
  if (!existing) {
    return null;
  }
  cache.delete(key);
  cache.set(key, existing);
  return existing;
}

function setLruValue<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  maxEntries: number,
  totalBytes: () => number,
  maxBytes: number,
): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > maxEntries || totalBytes() > maxBytes) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

const sliceTopologyCache = new Map<string, SliceTopologyCollection>();
const sliceFieldCache = new Map<string, SliceCollection>();
const projectionCache = new Map<string, ProjectionResult>();

function estimateTopologyBytes(value: SliceTopologyCollection): number {
  let bytes = 0;
  bytes += 6 * 8; // bounds
  bytes += value.segments.length * 88;
  for (const polygon of value.polygons) {
    bytes += polygon.points.length * 2 * 8;
    bytes += polygon.worldPoints.length * 3 * 8;
    bytes += polygon.sampleRefs.length * 24;
    bytes += 32;
  }
  return bytes;
}

function estimateFieldBytes(value: SliceCollection): number {
  let bytes = 0;
  bytes += 8 * 8; // ranges + bounds
  bytes += value.segments.length * 40;
  bytes += value.arrows.length * 88;
  for (const polygon of value.polygons) {
    bytes += polygon.points.length * 2 * 8;
    bytes += 56;
  }
  return bytes;
}

function estimateProjectionBytes(value: ProjectionResult): number {
  return value.values.byteLength + 8 * 8 + 64;
}

function totalTopologyCacheBytes(): number {
  let bytes = 0;
  for (const value of sliceTopologyCache.values()) {
    bytes += estimateTopologyBytes(value);
  }
  return bytes;
}

function totalFieldCacheBytes(): number {
  let bytes = 0;
  for (const value of sliceFieldCache.values()) {
    bytes += estimateFieldBytes(value);
  }
  return bytes;
}

function totalProjectionCacheBytes(): number {
  let bytes = 0;
  for (const value of projectionCache.values()) {
    bytes += estimateProjectionBytes(value);
  }
  return bytes;
}

function publishSliceCacheBuckets(): void {
  updateFrontendResourceBucket({
    id: "slice-topology-cache",
    label: "Slice topology cache",
    entries: sliceTopologyCache.size,
    estimatedBytes: totalTopologyCacheBytes(),
    capacity: MAX_TOPOLOGY_CACHE_BYTES,
  });
  updateFrontendResourceBucket({
    id: "slice-field-cache",
    label: "Slice field cache",
    entries: sliceFieldCache.size,
    estimatedBytes: totalFieldCacheBytes(),
    capacity: MAX_FIELD_CACHE_BYTES,
  });
  updateFrontendResourceBucket({
    id: "slice-projection-cache",
    label: "Slice projection cache",
    entries: projectionCache.size,
    estimatedBytes: totalProjectionCacheBytes(),
    capacity: MAX_PROJECTION_CACHE_BYTES,
  });
}

export function readSliceTopologyCache(key: string): SliceTopologyCollection | null {
  return getLruValue(sliceTopologyCache, key);
}

export function writeSliceTopologyCache(key: string, value: SliceTopologyCollection): void {
  setLruValue(
    sliceTopologyCache,
    key,
    value,
    MAX_TOPOLOGY_CACHE_ENTRIES,
    totalTopologyCacheBytes,
    MAX_TOPOLOGY_CACHE_BYTES,
  );
  publishSliceCacheBuckets();
}

export function readSliceFieldCache(key: string): SliceCollection | null {
  return getLruValue(sliceFieldCache, key);
}

export function writeSliceFieldCache(key: string, value: SliceCollection): void {
  setLruValue(
    sliceFieldCache,
    key,
    value,
    MAX_FIELD_CACHE_ENTRIES,
    totalFieldCacheBytes,
    MAX_FIELD_CACHE_BYTES,
  );
  publishSliceCacheBuckets();
}

export function readProjectionCache(key: string): ProjectionResult | null {
  return getLruValue(projectionCache, key);
}

export function writeProjectionCache(key: string, value: ProjectionResult): void {
  setLruValue(
    projectionCache,
    key,
    value,
    MAX_PROJECTION_CACHE_ENTRIES,
    totalProjectionCacheBytes,
    MAX_PROJECTION_CACHE_BYTES,
  );
  publishSliceCacheBuckets();
}

export function getSliceTopologyCached(
  key: string,
  compute: () => SliceTopologyCollection,
): { value: SliceTopologyCollection; cacheState: SliceCacheState } {
  const cached = readSliceTopologyCache(key);
  if (cached) {
    return { value: cached, cacheState: "hit" };
  }
  const value = compute();
  writeSliceTopologyCache(key, value);
  return { value, cacheState: "miss" };
}

export function getSliceFieldCached(
  key: string,
  compute: () => SliceCollection,
): { value: SliceCollection; cacheState: SliceCacheState } {
  const cached = readSliceFieldCache(key);
  if (cached) {
    return { value: cached, cacheState: "hit" };
  }
  const value = compute();
  writeSliceFieldCache(key, value);
  return { value, cacheState: "miss" };
}

export function getSliceCacheSnapshot(): {
  topologyEntries: number;
  fieldEntries: number;
  projectionEntries: number;
  topologyCapacity: number;
  fieldCapacity: number;
  projectionCapacity: number;
  topologyMaxBytes: number;
  fieldMaxBytes: number;
  projectionMaxBytes: number;
  topologyEstimatedBytes: number;
  fieldEstimatedBytes: number;
  projectionEstimatedBytes: number;
} {
  return {
    topologyEntries: sliceTopologyCache.size,
    fieldEntries: sliceFieldCache.size,
    projectionEntries: projectionCache.size,
    topologyCapacity: MAX_TOPOLOGY_CACHE_ENTRIES,
    fieldCapacity: MAX_FIELD_CACHE_ENTRIES,
    projectionCapacity: MAX_PROJECTION_CACHE_ENTRIES,
    topologyMaxBytes: MAX_TOPOLOGY_CACHE_BYTES,
    fieldMaxBytes: MAX_FIELD_CACHE_BYTES,
    projectionMaxBytes: MAX_PROJECTION_CACHE_BYTES,
    topologyEstimatedBytes: totalTopologyCacheBytes(),
    fieldEstimatedBytes: totalFieldCacheBytes(),
    projectionEstimatedBytes: totalProjectionCacheBytes(),
  };
}

// ── Cache keys ───────────────────────────────────────────────────

/**
 * Returns a string key that changes whenever the topology of the slice
 * would change (plane orientation, position, thickness).
 */
export function topologyCacheKey(
  query: FemSliceQuery,
  context: FemSliceCacheContext,
): string {
  return [
    query.orientation,
    query.thicknessMode,
    context.planeWorldCoord.toPrecision(12),
    query.thicknessWorld,
    context.boundsStrategy ?? "visible-context",
    objectIdentity(context.meshNodes ?? null),
    objectIdentity(context.meshElements ?? null),
    objectIdentity(context.meshBoundaryFaces ?? null),
    objectIdentity(context.visibleElements ?? null),
    objectIdentity(context.visibleBoundaryFaces ?? null),
    visiblePartsFingerprint(context.visiblePartIds),
  ].join(":");
}

/**
 * Returns a string key for the field sample level.  Changes when the
 * quantity or component changes (but topology stays the same).
 */
export function fieldCacheKey(
  query: FemSliceQuery,
  context: FemSliceCacheContext,
): string {
  return [
    topologyCacheKey(query, context),
    query.quantityId,
    query.component,
    query.aggregation,
    objectIdentity(context.fieldX ?? null),
    objectIdentity(context.fieldY ?? null),
    objectIdentity(context.fieldZ ?? null),
    context.fieldRevision ?? "none",
    context.fieldNComp ?? "none",
  ].join(":");
}

export function projectionCacheKey(args: {
  orientation: string;
  component: string;
  reduction: string;
  includeAirAsZero: boolean;
  samples: number;
  resolution: number;
  maxElements?: number;
  boundsStrategy?: string;
  meshNodes?: object | null;
  meshElements?: object | null;
  meshBoundaryFaces?: object | null;
  visibleElements?: object | null;
  visibleBoundaryFaces?: object | null;
  visiblePartIds?: Iterable<string>;
  fieldX?: object | null;
  fieldY?: object | null;
  fieldZ?: object | null;
  fieldRevision?: string | number | null;
  fieldNComp?: number | null;
  quantityId?: string | null;
}): string {
  return [
    "projection",
    args.orientation,
    args.component,
    args.reduction,
    args.includeAirAsZero ? "air0" : "occupied",
    Math.round(args.samples),
    Math.round(args.resolution),
    Math.round(args.maxElements ?? 0),
    args.boundsStrategy ?? "visible-context",
    objectIdentity(args.meshNodes ?? null),
    objectIdentity(args.meshElements ?? null),
    objectIdentity(args.meshBoundaryFaces ?? null),
    objectIdentity(args.visibleElements ?? null),
    objectIdentity(args.visibleBoundaryFaces ?? null),
    visiblePartsFingerprint(args.visiblePartIds),
    args.quantityId ?? "m",
    objectIdentity(args.fieldX ?? null),
    objectIdentity(args.fieldY ?? null),
    objectIdentity(args.fieldZ ?? null),
    args.fieldRevision ?? "none",
    args.fieldNComp ?? "none",
  ].join(":");
}

// ── Memo guards ──────────────────────────────────────────────────

/**
 * Lightweight guard that tells callers whether a recompute is needed.
 *
 * Usage (inside useMemo deps):
 *   const topoKey = topologyCacheKey(query, context);
 *   const fieldKey = fieldCacheKey(query, context);
 *   // useMemo(..., [topoKey])  for topology
 *   // useMemo(..., [fieldKey]) for field samples
 */
export function shouldRecomputeTopology(
  prev: string | null,
  next: string,
): boolean {
  return prev !== next;
}

export function shouldRecomputeField(
  prev: string | null,
  next: string,
): boolean {
  return prev !== next;
}
