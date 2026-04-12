/**
 * Canonical slice query model for the FEM 2D view.
 *
 * `FemSliceQuery` is the single source of truth describing **what** the 2D
 * viewport is computing.  Renderers consume the result; they never derive
 * plane/position/thickness/aggregation on their own.
 */

// ── Enums / literal unions ───────────────────────────────────────

export type SlicePlane = "xy" | "xz" | "yz";

/** How the plane position is specified. */
export type PositionMode =
  | "world" // absolute metres
  | "normalized" // 0..1 within mesh extent
  | "sync_3d_clip"; // driven by the 3D clip slider

/** How the slice handles thickness / depth. */
export type ThicknessMode =
  | "exact" // zero-thickness plane intersection
  | "slab" // finite slab around the plane
  | "projection"; // full (or windowed) projection along normal

/** Scalar reduction applied across the thickness / slab direction. */
export type SliceAggregation =
  | "sample" // value at the exact plane (thicknessMode "exact")
  | "mean"
  | "integral"
  | "min"
  | "max"
  | "rms";

/** How vectors are projected onto the 2D plane. */
export type VectorProjectionMode =
  | "off"
  | "in_plane"
  | "normal"
  | "projected_3d";

/** How the colour-scale range is determined. */
export type ColorScaleMode =
  | "slice_auto" // fit to the current slice data
  | "global_auto" // fit to the full quantity range
  | "locked_manual" // user-pinned [min, max]
  | "symmetric_zero"; // symmetric around 0

/** Which part of the mesh is included in the slice. */
export type SliceScope =
  | "visible" // only currently-visible parts
  | "selection" // only selected objects
  | "full_domain"; // everything

/** How the viewport extent adapts to the data. */
export type ExtentMode =
  | "fit_visible" // zoom to visible parts
  | "fit_intersection" // zoom to actual plane intersection
  | "fixed_world_window"; // user-pinned u/v window

/** Selectable vector component. */
export type VectorComponent = "x" | "y" | "z" | "magnitude";

// ── The canonical query ──────────────────────────────────────────

/**
 * Complete description of a 2D FEM slice.
 *
 * Every field here is a *user intent* parameter — the query describes
 * **what** the user wants to see, not the implementation details of
 * how the slice engine computes it.
 */
export interface FemSliceQuery {
  // -- Plane ----------------------------------------------------------
  /** Orientation of the cutting plane. */
  orientation: SlicePlane;

  // -- Position -------------------------------------------------------
  /** How `planeOffset` is interpreted. */
  positionMode: PositionMode;
  /**
   * Offset along the normal axis.
   * - `positionMode "world"`:      metres
   * - `positionMode "normalized"`: 0..1 fraction of mesh extent
   * - `positionMode "sync_3d_clip"`: 0..100 clip-slider value
   */
  planeOffset: number;

  // -- Thickness / depth ----------------------------------------------
  thicknessMode: ThicknessMode;
  /**
   * Half-thickness in the same unit system as `positionMode`.
   * Ignored when `thicknessMode === "exact"`.
   * For "projection", 0 means full extent along normal.
   */
  thicknessWorld: number;

  // -- Aggregation ----------------------------------------------------
  aggregation: SliceAggregation;

  // -- Data -----------------------------------------------------------
  quantityId: string;
  component: VectorComponent;

  // -- Vectors --------------------------------------------------------
  vectorMode: VectorProjectionMode;

  // -- Scope / extent -------------------------------------------------
  scope: SliceScope;
  extentMode: ExtentMode;

  // -- Colour scale ---------------------------------------------------
  colorScaleMode: ColorScaleMode;
  /** Manual range — only meaningful when `colorScaleMode === "locked_manual"`. */
  lockedRange?: [number, number];
}

// ── Defaults ─────────────────────────────────────────────────────

/** Sensible starting query. */
export function defaultSliceQuery(): FemSliceQuery {
  return {
    orientation: "xy",
    positionMode: "sync_3d_clip",
    planeOffset: 50,
    thicknessMode: "exact",
    thicknessWorld: 0,
    aggregation: "sample",
    quantityId: "m",
    component: "magnitude",
    vectorMode: "off",
    scope: "visible",
    extentMode: "fit_visible",
    colorScaleMode: "slice_auto",
  };
}

// ── Derived helpers ──────────────────────────────────────────────

/** Build a self-describing title string for the current query. */
export function sliceTitle(q: FemSliceQuery, planeWorldCoord: number): string {
  const qty = `${q.quantityId}.${q.component}`;
  const plane = q.orientation.toUpperCase();
  const pos = formatSI(planeWorldCoord);

  switch (q.thicknessMode) {
    case "exact":
      return `${qty} | Section | ${plane} @ ${normalAxisLabel(q.orientation)} = ${pos}`;
    case "slab":
      return `${qty} | Slab ${q.aggregation} | ${plane} | ${normalAxisLabel(q.orientation)} = ${pos} | thickness = ${formatSI(q.thicknessWorld * 2)}`;
    case "projection":
      return `${qty} | Projection ${q.aggregation} | ${plane}`;
  }
}

/** Human label for the normal axis of a given plane. */
export function normalAxisLabel(plane: SlicePlane): string {
  switch (plane) {
    case "xy": return "z";
    case "xz": return "y";
    case "yz": return "x";
  }
}

/** Minimal SI formatter (m → nm / µm / mm). */
function formatSI(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0 m";
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)} µm`;
  if (abs >= 1e-9) return `${(value * 1e9).toFixed(2)} nm`;
  return `${value.toExponential(2)} m`;
}
