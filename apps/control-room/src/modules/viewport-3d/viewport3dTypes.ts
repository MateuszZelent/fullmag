import type { ColorRepresentation } from "three";

export interface Viewport3DColors {
  accent: ColorRepresentation;
  accentStrong?: ColorRepresentation;
  background: ColorRepresentation;
  danger?: ColorRepresentation;
  field: ColorRepresentation;
  mesh: ColorRepresentation;
  panel?: ColorRepresentation;
  panelRaised?: ColorRepresentation;
  success?: ColorRepresentation;
  textPrimary?: ColorRepresentation;
  textSecondary?: ColorRepresentation;
  wire: ColorRepresentation;
}

export const VIEWPORT_3D_FRAMELOOP = "demand" as const;

export const VIEWPORT_3D_DIRTY_REASONS = [
  "camera-clip",
  "camera-control",
  "camera-control-target",
  "camera-fit",
  "camera-init",
  "camera-orbit-debug",
  "camera-orbit-debug-commit",
  "camera-orbit-debug-request",
  "camera-projection",
  "camera-projection-followup",
  "camera-resource",
  "canvas-mounted",
  "airbox-field-colors",
  "airbox-points",
  "airbox-surface",
  "airbox-wireframe",
  "clip-plane",
  "clip-plane-cleanup",
  "context-restored",
  "cross-section-frame-preview",
  "dimension-frame",
  "fdm-cuboids",
  "fallback-topology-points",
  "fallback-topology-surface",
  "fallback-topology-wireframe",
  "field-colors",
  "field-scalar-shader",
  "hysteresis-replay-glyph",
  "mesh-size-highlight",
  "mesh-part-points",
  "mesh-part-surface",
  "mesh-part-wireframe",
  "mesh-quality-colors",
  "model-layer-stage",
  "model-layer-stage-reset",
  "orientation-hud-mounted",
  "orientation-hud-orbit",
  "orientation-hud-snap",
  "planar-monitor-frame-preview",
  "primitive-geometry",
  "region-mesh-overlay",
  "render-adoption",
  "resources-updated",
  "topology",
  "vector-glyph-build",
  "vector-glyph-colors",
  "vector-glyph-material",
  "vector-glyphs",
] as const;

export type Viewport3DDirtyReason = (typeof VIEWPORT_3D_DIRTY_REASONS)[number];
