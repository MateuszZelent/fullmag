import type { PlanarFieldMetaResource, VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { FieldMapRenderModel, PlanarFrame } from "./fieldMapRenderModel";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
export type PlanarFieldOverlay = NonNullable<Planar["field_overlays"]>[number];
export function planarMetaFrame(meta: PlanarFieldMetaResource): PlanarFrame {
  return {
    origin: meta.frame.origin_m as [number, number, number],
    normal: meta.frame.normal as [number, number, number],
    uAxis: meta.frame.u_axis as [number, number, number],
    vAxis: meta.frame.v_axis as [number, number, number],
  };
}

/** Position is a world-axis coordinate, not a signed distance along e.g. -Y. */
export function planarPhysicalPosition(meta: PlanarFieldMetaResource): number {
  const normal = meta.frame.normal;
  const axis = normal.reduce((best, value, index) => Math.abs(value) > Math.abs(normal[best] ?? 0) ? index : best, 0);
  return meta.frame.origin_m[axis] ?? 0;
}

export type PlanarFrameAlignment = { ok: true; shift: readonly [number, number] } | { ok: false; reason: string };

/** Compare physical planes, never independent cell indices or slice fractions. */
export function alignPlanarFieldFrames(base: PlanarFieldMetaResource, overlay: PlanarFieldMetaResource): PlanarFrameAlignment {
  if (base.scene_revision !== overlay.scene_revision || base.generation_id !== overlay.generation_id || base.field_source !== overlay.field_source) {
    return { ok: false, reason: "Waiting for fields from the same domain and source." };
  }
  if (JSON.stringify(base.operator) !== JSON.stringify(overlay.operator)) {
    return { ok: false, reason: "The field layers use different section operators." };
  }
  for (const axis of ["normal", "u_axis", "v_axis"] as const) {
    if (base.frame[axis].some((value, index) => !Number.isFinite(value) || !Number.isFinite(overlay.frame[axis][index]) ||
        Math.abs(value - (overlay.frame[axis][index] ?? NaN)) > 1e-10)) {
      return { ok: false, reason: "The field layers use different plane orientations." };
    }
  }
  const delta = overlay.frame.origin_m.map((value, index) => value - (base.frame.origin_m[index] ?? NaN));
  const dot = (axis: readonly number[]) => delta.reduce((sum, value, index) => sum + value * (axis[index] ?? NaN), 0);
  const span = Math.max(...base.frame.bounds_uv_m.map(Math.abs), ...overlay.frame.bounds_uv_m.map(Math.abs), 1e-12);
  const distance = dot(base.frame.normal);
  if (!Number.isFinite(distance) || Math.abs(distance) > span * 1e-8) {
    return { ok: false, reason: "The field layers do not sample the same physical plane." };
  }
  return { ok: true, shift: [dot(base.frame.u_axis), dot(base.frame.v_axis)] };
}

/** The raster keeps its own resolution and physical extent in the base UV frame. */
export function placePlanarOverlay(model: FieldMapRenderModel, base: FieldMapRenderModel, shift: readonly [number, number]): FieldMapRenderModel {
  const [u, v] = shift;
  return {
    ...model,
    bounds: [model.bounds[0] + u, model.bounds[1] + u, model.bounds[2] + v, model.bounds[3] + v],
    boundsCenter: [model.boundsCenter[0] + u, model.boundsCenter[1] + v],
    boundsOutline: null,
    // Sample markers carry frame coordinates, so they move with the raster.
    samplePoints: u === 0 && v === 0
      ? model.samplePoints
      : model.samplePoints.map((point) => ({ ...point, u: point.u + u, v: point.v + v })),
    frame: base.frame,
    viewport: base.viewport,
    interaction: base.interaction,
  };
}
