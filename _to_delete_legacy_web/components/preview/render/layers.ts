/**
 * Three.js render layer assignments for the viewport.
 *
 * Layers control which objects are visible to which camera passes.
 * Layer 0 is the default (always rendered). Higher layers are opt-in.
 */
export const RENDER_LAYERS = {
  /** Main geometry — depthWrite=true, opaque pass */
  OPAQUE_GEOMETRY: 0,
  /** Ghost / context objects — transparent, depth read only */
  TRANSPARENT_CONTEXT: 1,
  /** Selection highlight overlay */
  SELECTION_HIGHLIGHT: 2,
  /** Field arrows / glyphs */
  FIELD_GLYPHS: 3,
  /** Transform gizmos */
  GIZMOS: 4,
  /** Axes and labels */
  AXES_LABELS: 5,
  /** Clipping plane cap geometry */
  CLIP_CAPS: 6,
  /** Sharp crease / boundary feature edges */
  FEATURE_EDGES: 7,
  /** Hidden-line silhouette helpers */
  HIDDEN_LINE_HELPERS: 8,
  /** Ghosted / dimmed context bodies */
  GHOST_CONTEXT: 9,
  /** CPU picking proxy (invisible to user camera) */
  PICKING_PROXY: 10,
  /** Probe and measurement markers */
  PROBE_MARKERS: 11,
  /** Post-process field overlay (e.g. contour) */
  FIELD_OVERLAY: 12,
  /** Screen-space helpers — annotations, dimension lines */
  SCREENSPACE_HELPERS: 13,
} as const;

export type RenderLayerKey = keyof typeof RENDER_LAYERS;
