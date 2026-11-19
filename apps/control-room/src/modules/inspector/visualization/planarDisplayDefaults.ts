import type { VisualizationStatePatch, VisualizationStateResource } from "@/kernel/api/apiTypes";
import { DIRECTION_COLORMAP } from "@/shared/visualization/directionColor";

import { createFieldLayer } from "./planarFieldLayers";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;

/**
 * Display part of the default planar state of a new session
 * (`default_planar_visualization_state`, ADR 0080). `source` and
 * `default_slice` are what the user looks at, not how; Reset display keeps them.
 */
export function defaultPlanarDisplayPatch(): PlanarPatch {
  return {
    visible: true,
    layer_model: "layers",
    field_overlays: [createFieldLayer("all")],
    crop: null,
    view_scope: { kind: "monitor_target" },
    quantity_id: "m",
    component: "magnitude",
    colormap: DIRECTION_COLORMAP,
    range: { mode: "auto", min: null, max: null },
    raster_opacity: 1,
    viewport_colorbar_visible: true,
    display_unit: null,
    resolution: { width: 512, height: 512, vector_budget: 2_000 },
    quality: "interactive",
    layers: {
      bounds: false,
      raster: true,
      contours: false,
      mesh: false,
      boundaries: false,
      points: false,
      vectors: false,
      probes: true,
      streamlines: false,
    },
    wireframe_style: { color: "var(--fm-border-strong)", opacity: 1 },
    target_overrides: [],
    point_style: { color: "var(--fm-accent)", opacity: 1, size: 3 },
    vector_style: {
      length_mode: "uniform",
      color_mode: "orientation",
      scale: 1,
      opacity: 1,
      thickness: 1,
      monochrome_color: "var(--fm-text-primary)",
    },
    interaction: { zoom: 1, pan_u_m: 0, pan_v_m: 0 },
    multislice: { enabled: false, position_fractions: [0.25, 0.5, 0.75] },
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    // A missing optional field and its explicit default read the same.
    return (left ?? null) === (right ?? null);
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** True when any display field differs from the new-session default. */
export function planarDisplayDiffersFromDefault(planar: Planar): boolean {
  const defaults = defaultPlanarDisplayPatch();
  return (Object.keys(defaults) as (keyof PlanarPatch)[]).some((key) => {
    const expected = defaults[key];
    const raw = (planar as Record<string, unknown>)[key];
    const current = raw === undefined && Array.isArray(expected) ? [] : raw;
    if (key === "layers") {
      return !sameValue({ streamlines: false, ...(current as object) }, expected);
    }
    if (key === "field_overlays") {
      const layers = (current as Planar["field_overlays"]) ?? [];
      return !sameValue(layers.map((layer) => ({
        visible: true, points_visible: false, mesh_visible: false,
        contours_visible: false, streamlines_visible: false, ...layer,
      })), expected);
    }
    return !sameValue(current, expected);
  });
}
