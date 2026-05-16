/**
 * Exact-section slice engine.
 *
 * Computes a zero-thickness plane intersection through tetra / boundary
 * meshes and returns a canonical `SliceResult` that renderers consume
 * directly.
 *
 * This module is a thin adapter around `collectSegments` from
 * `femSliceGeometry.ts` (which remains the algorithmic core).
 * It adds the `FemSliceQuery` → `SliceResult` bridge so that
 * renderers never need to understand query semantics.
 */

import type { FemMeshData } from "./femMeshTypes";
import type { FemSliceQuery, VectorComponent } from "./femSliceQuery";
import type { ResolvedSlicePlane } from "./useFemSliceViewportModel";
import type { SliceVisibilityState } from "./femSliceUtils";
import {
  collectSegments,
  type SliceCollection,
  type SliceBoundsStrategy,
  type Polygon2D,
  type Segment2D,
  type SliceArrow2D,
} from "./femSliceGeometry";

// ── SliceResult: the canonical output  ───────────────────────────

/** Scalar range stats for a slice result. */
export interface SliceValueRange {
  min: number;
  max: number;
}

/** 2D axis-aligned bounds of the slice geometry. */
export interface SliceBounds {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/**
 * The canonical result of a slice computation.
 *
 * Every renderer — canvas, Plotly, future WebGL — consumes this
 * structure and only this structure.
 */
export interface SliceResult {
  // ── Identity ──
  /** World coordinate on the normal axis. */
  planeCoord: number;
  /** Labels for the three axes. */
  normalLabel: string;
  uLabel: string;
  vLabel: string;

  // ── Geometry ──
  bounds: SliceBounds;
  polygons: Polygon2D[];
  segments: Segment2D[];
  arrows: SliceArrow2D[];

  // ── Data range ──
  valueRange: SliceValueRange;

  // ── Provenance ──
  /** Which thickness mode produced this result. */
  thicknessMode: FemSliceQuery["thicknessMode"];
  /** Which aggregation was used. */
  aggregation: FemSliceQuery["aggregation"];
}

// ── Compute ──────────────────────────────────────────────────────

/**
 * Run an exact-section slice.
 *
 * For `thicknessMode === "exact"` this delegates directly to
 * `collectSegments`.  In the future, `slab` and `projection`
 * branches will call dedicated engines.
 */
export function computeExactSlice(args: {
  meshData: FemMeshData;
  query: FemSliceQuery;
  resolved: ResolvedSlicePlane;
  visibility: SliceVisibilityState | null;
  boundsStrategy: SliceBoundsStrategy;
}): SliceResult {
  const { meshData, query, resolved, visibility, boundsStrategy } = args;

  const collection: SliceCollection = collectSegments(
    meshData,
    query.orientation,
    query.component,
    resolved.planeWorldCoord,
    visibility,
    boundsStrategy,
  );

  return collectionToResult(collection, query);
}

// ── Internal helpers ─────────────────────────────────────────────

function collectionToResult(
  collection: SliceCollection,
  query: FemSliceQuery,
): SliceResult {
  return {
    planeCoord: collection.planeCoord,
    normalLabel: collection.normalLabel,
    uLabel: collection.uLabel,
    vLabel: collection.vLabel,
    bounds: collection.bounds,
    polygons: collection.polygons,
    segments: collection.segments,
    arrows: collection.arrows,
    valueRange: collection.valueRange,
    thicknessMode: query.thicknessMode,
    aggregation: query.aggregation,
  };
}
