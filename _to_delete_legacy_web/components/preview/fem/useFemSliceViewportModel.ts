/**
 * Manages the `FemSliceQuery` state, resolves world coordinates from the
 * mesh extent, and provides a canonical `SliceResult` to renderers.
 *
 * This hook is the single place where query state lives. Renderers,
 * toolbars, and probes all read from / write to this model.
 */

import { useCallback, useMemo, useReducer } from "react";
import type { FemMeshData } from "./femMeshTypes";
import type {
  FemSliceQuery,
  SlicePlane,
  PositionMode,
  ThicknessMode,
  SliceAggregation,
  VectorProjectionMode,
  ColorScaleMode,
  VectorComponent,
} from "./femSliceQuery";
import { defaultSliceQuery, normalAxisLabel } from "./femSliceQuery";
import { axisIndices } from "./femSliceGeometry";
import { normalizedClipToWorld, worldToNormalizedClip } from "./femSliceUtils";

// ── Resolved world-space geometry ────────────────────────────────

/** Axis-aligned extent of the mesh along the slice normal. */
export interface NormalExtent {
  min: number;
  max: number;
  span: number;
}

/** Fully resolved world-space parameters derived from query + mesh. */
export interface ResolvedSlicePlane {
  /** World-coordinate value on the normal axis. */
  planeWorldCoord: number;
  /** Extent of the mesh along the normal. */
  normalExtent: NormalExtent;
  /** Normal axis index (0=x, 1=y, 2=z). */
  normalIndex: 0 | 1 | 2;
  /** In-plane axes indices. */
  uIndex: 0 | 1 | 2;
  vIndex: 0 | 1 | 2;
  /** Labels. */
  normalLabel: string;
  uLabel: string;
  vLabel: string;
}

// ── Reducer ──────────────────────────────────────────────────────

type QueryAction =
  | { type: "set_orientation"; orientation: SlicePlane }
  | { type: "set_position_mode"; mode: PositionMode }
  | { type: "set_plane_offset"; offset: number }
  | { type: "set_thickness_mode"; mode: ThicknessMode }
  | { type: "set_thickness"; value: number }
  | { type: "set_aggregation"; aggregation: SliceAggregation }
  | { type: "set_quantity"; quantityId: string }
  | { type: "set_component"; component: VectorComponent }
  | { type: "set_vector_mode"; mode: VectorProjectionMode }
  | { type: "set_color_scale_mode"; mode: ColorScaleMode }
  | { type: "set_locked_range"; range: [number, number] }
  | { type: "set_sync_clip"; clipPos: number }
  | { type: "replace"; query: FemSliceQuery };

function queryReducer(state: FemSliceQuery, action: QueryAction): FemSliceQuery {
  switch (action.type) {
    case "set_orientation":
      return { ...state, orientation: action.orientation };
    case "set_position_mode":
      return { ...state, positionMode: action.mode };
    case "set_plane_offset":
      return { ...state, planeOffset: action.offset };
    case "set_thickness_mode": {
      const aggregation =
        action.mode === "exact" ? "sample" as const : state.aggregation === "sample" ? "mean" as const : state.aggregation;
      return { ...state, thicknessMode: action.mode, aggregation };
    }
    case "set_thickness":
      return { ...state, thicknessWorld: action.value };
    case "set_aggregation":
      return { ...state, aggregation: action.aggregation };
    case "set_quantity":
      return { ...state, quantityId: action.quantityId };
    case "set_component":
      return { ...state, component: action.component };
    case "set_vector_mode":
      return { ...state, vectorMode: action.mode };
    case "set_color_scale_mode":
      return { ...state, colorScaleMode: action.mode };
    case "set_locked_range":
      return { ...state, lockedRange: action.range, colorScaleMode: "locked_manual" };
    case "set_sync_clip":
      return { ...state, positionMode: "sync_3d_clip", planeOffset: action.clipPos };
    case "replace":
      return action.query;
  }
}

// ── Hook ─────────────────────────────────────────────────────────

export interface UseFemSliceViewportModelParams {
  meshData: FemMeshData;
  /** Optional initial query override — e.g. restored from a preset. */
  initialQuery?: Partial<FemSliceQuery>;
  /** External clip position from the 3D viewport (0..100). */
  externalClipPos?: number;
  /** External clip axis from the 3D viewport. */
  externalClipAxis?: "x" | "y" | "z";
}

export interface FemSliceViewportModel {
  /** The current query (user intent). */
  query: FemSliceQuery;
  /** Resolved world-space plane info. */
  resolved: ResolvedSlicePlane;
  /** Whether the 2D plane is synced to the 3D clip. */
  isSyncedTo3D: boolean;

  // ── Dispatchers (one per field) ──
  setOrientation: (orientation: SlicePlane) => void;
  setPositionMode: (mode: PositionMode) => void;
  setPlaneOffset: (offset: number) => void;
  setThicknessMode: (mode: ThicknessMode) => void;
  setThickness: (value: number) => void;
  setAggregation: (aggregation: SliceAggregation) => void;
  setQuantity: (quantityId: string) => void;
  setComponent: (component: VectorComponent) => void;
  setVectorMode: (mode: VectorProjectionMode) => void;
  setColorScaleMode: (mode: ColorScaleMode) => void;
  setLockedRange: (range: [number, number]) => void;
  /** Convenience: jump to a world-position and switch to world mode. */
  jumpToWorld: (value: number) => void;
  /** Convenience: sync from 3D clip slider. */
  syncFromClip: (clipPos: number) => void;
  /** Replace the full query. */
  replaceQuery: (query: FemSliceQuery) => void;
}

export function useFemSliceViewportModel(
  params: UseFemSliceViewportModelParams,
): FemSliceViewportModel {
  const { meshData, initialQuery, externalClipPos, externalClipAxis } = params;

  const [query, dispatch] = useReducer(queryReducer, undefined, () => ({
    ...defaultSliceQuery(),
    ...initialQuery,
  }));

  // ── Resolve the normal extent from the mesh ───────
  const { normal, u, v } = axisIndices(query.orientation);

  const normalExtent = useMemo<NormalExtent>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < meshData.nNodes; i++) {
      const val = meshData.nodes[i * 3 + normal];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: 0, max: 0, span: 0 };
    }
    return { min, max, span: max - min };
  }, [meshData.nNodes, meshData.nodes, normal]);

  // ── Resolve world-coordinate of the plane ─────────
  const planeWorldCoord = useMemo(() => {
    switch (query.positionMode) {
      case "world":
        return query.planeOffset;
      case "normalized":
        return normalExtent.min + query.planeOffset * normalExtent.span;
      case "sync_3d_clip":
        return normalizedClipToWorld(normalExtent.min, normalExtent.max, query.planeOffset);
    }
  }, [query.positionMode, query.planeOffset, normalExtent]);

  const axisLabel = (idx: 0 | 1 | 2) => (idx === 0 ? "x" : idx === 1 ? "y" : "z");

  const resolved = useMemo<ResolvedSlicePlane>(
    () => ({
      planeWorldCoord,
      normalExtent,
      normalIndex: normal,
      uIndex: u,
      vIndex: v,
      normalLabel: axisLabel(normal),
      uLabel: axisLabel(u),
      vLabel: axisLabel(v),
    }),
    [planeWorldCoord, normalExtent, normal, u, v],
  );

  // ── Dispatchers ────────────────────────────────────
  const setOrientation = useCallback(
    (orientation: SlicePlane) => dispatch({ type: "set_orientation", orientation }),
    [],
  );
  const setPositionMode = useCallback(
    (mode: PositionMode) => dispatch({ type: "set_position_mode", mode }),
    [],
  );
  const setPlaneOffset = useCallback(
    (offset: number) => dispatch({ type: "set_plane_offset", offset }),
    [],
  );
  const setThicknessMode = useCallback(
    (mode: ThicknessMode) => dispatch({ type: "set_thickness_mode", mode }),
    [],
  );
  const setThickness = useCallback(
    (value: number) => dispatch({ type: "set_thickness", value }),
    [],
  );
  const setAggregation = useCallback(
    (aggregation: SliceAggregation) => dispatch({ type: "set_aggregation", aggregation }),
    [],
  );
  const setQuantity = useCallback(
    (quantityId: string) => dispatch({ type: "set_quantity", quantityId }),
    [],
  );
  const setComponent = useCallback(
    (component: VectorComponent) => dispatch({ type: "set_component", component }),
    [],
  );
  const setVectorMode = useCallback(
    (mode: VectorProjectionMode) => dispatch({ type: "set_vector_mode", mode }),
    [],
  );
  const setColorScaleMode = useCallback(
    (mode: ColorScaleMode) => dispatch({ type: "set_color_scale_mode", mode }),
    [],
  );
  const setLockedRange = useCallback(
    (range: [number, number]) => dispatch({ type: "set_locked_range", range }),
    [],
  );
  const jumpToWorld = useCallback(
    (value: number) => {
      dispatch({ type: "set_position_mode", mode: "world" });
      dispatch({ type: "set_plane_offset", offset: value });
    },
    [],
  );
  const syncFromClip = useCallback(
    (clipPos: number) => dispatch({ type: "set_sync_clip", clipPos }),
    [],
  );
  const replaceQuery = useCallback(
    (q: FemSliceQuery) => dispatch({ type: "replace", query: q }),
    [],
  );

  return {
    query,
    resolved,
    isSyncedTo3D: query.positionMode === "sync_3d_clip",
    setOrientation,
    setPositionMode,
    setPlaneOffset,
    setThicknessMode,
    setThickness,
    setAggregation,
    setQuantity,
    setComponent,
    setVectorMode,
    setColorScaleMode,
    setLockedRange,
    jumpToWorld,
    syncFromClip,
    replaceQuery,
  };
}
