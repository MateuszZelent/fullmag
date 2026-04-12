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
import type { SliceResult } from "./femSliceExact";

// ── Cache keys ───────────────────────────────────────────────────

/**
 * Returns a string key that changes whenever the topology of the slice
 * would change (plane orientation, position, thickness).
 */
export function topologyCacheKey(query: FemSliceQuery, planeWorldCoord: number): string {
  return `${query.orientation}:${query.thicknessMode}:${planeWorldCoord.toPrecision(12)}:${query.thicknessWorld}`;
}

/**
 * Returns a string key for the field sample level.  Changes when the
 * quantity or component changes (but topology stays the same).
 */
export function fieldCacheKey(query: FemSliceQuery, planeWorldCoord: number): string {
  return `${topologyCacheKey(query, planeWorldCoord)}:${query.quantityId}:${query.component}:${query.aggregation}`;
}

// ── Memo guards ──────────────────────────────────────────────────

/**
 * Lightweight guard that tells callers whether a recompute is needed.
 *
 * Usage (inside useMemo deps):
 *   const topoKey = topologyCacheKey(query, resolved.planeWorldCoord);
 *   const fieldKey = fieldCacheKey(query, resolved.planeWorldCoord);
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
