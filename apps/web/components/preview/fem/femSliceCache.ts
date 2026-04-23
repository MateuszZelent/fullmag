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

function getLruValue<T>(cache: Map<string, T>, key: string): T | null {
  const existing = cache.get(key);
  if (!existing) {
    return null;
  }
  cache.delete(key);
  cache.set(key, existing);
  return existing;
}

function setLruValue<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

const sliceTopologyCache = new Map<string, SliceTopologyCollection>();
const sliceFieldCache = new Map<string, SliceCollection>();

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

function publishSliceCacheBuckets(): void {
  updateFrontendResourceBucket({
    id: "slice-topology-cache",
    label: "Slice topology cache",
    entries: sliceTopologyCache.size,
    estimatedBytes: totalTopologyCacheBytes(),
    capacity: MAX_TOPOLOGY_CACHE_ENTRIES,
  });
  updateFrontendResourceBucket({
    id: "slice-field-cache",
    label: "Slice field cache",
    entries: sliceFieldCache.size,
    estimatedBytes: totalFieldCacheBytes(),
    capacity: MAX_FIELD_CACHE_ENTRIES,
  });
}

export function readSliceTopologyCache(key: string): SliceTopologyCollection | null {
  return getLruValue(sliceTopologyCache, key);
}

export function writeSliceTopologyCache(key: string, value: SliceTopologyCollection): void {
  setLruValue(sliceTopologyCache, key, value, MAX_TOPOLOGY_CACHE_ENTRIES);
  publishSliceCacheBuckets();
}

export function readSliceFieldCache(key: string): SliceCollection | null {
  return getLruValue(sliceFieldCache, key);
}

export function writeSliceFieldCache(key: string, value: SliceCollection): void {
  setLruValue(sliceFieldCache, key, value, MAX_FIELD_CACHE_ENTRIES);
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
  topologyCapacity: number;
  fieldCapacity: number;
  topologyEstimatedBytes: number;
  fieldEstimatedBytes: number;
} {
  return {
    topologyEntries: sliceTopologyCache.size,
    fieldEntries: sliceFieldCache.size,
    topologyCapacity: MAX_TOPOLOGY_CACHE_ENTRIES,
    fieldCapacity: MAX_FIELD_CACHE_ENTRIES,
    topologyEstimatedBytes: totalTopologyCacheBytes(),
    fieldEstimatedBytes: totalFieldCacheBytes(),
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
