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
