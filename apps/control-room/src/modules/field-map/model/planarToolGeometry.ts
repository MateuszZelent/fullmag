import type {
  PlanarCursorUv,
  PlanarUvRect,
  PlanarUvSegment,
} from "@/kernel/visualization/planarToolStore";

import type { PlanarInteraction } from "../renderer/planarInteraction";

/** Shortest drag side (CSS px) a box tool accepts; below it is a click (Review Focus 2). */
export const MIN_TOOL_DRAG_PX = 4;

type UvBounds = readonly [number, number, number, number];

/** Axis-aligned rectangle spanned by two corners, whichever way the drag went. */
export function normalizeUvRect(a: PlanarCursorUv, b: PlanarCursorUv): PlanarUvRect {
  return {
    u_min_m: Math.min(a.u_m, b.u_m),
    u_max_m: Math.max(a.u_m, b.u_m),
    v_min_m: Math.min(a.v_m, b.v_m),
    v_max_m: Math.max(a.v_m, b.v_m),
  };
}

/**
 * View interaction that shows the whole rectangle. Zoom is uniform (the
 * canvas keeps the frame's u:v aspect), so the limiting side decides it and a
 * box of another aspect ratio still fits completely. Pan is relative to the
 * centre of `frameBounds`, as everywhere in `planar.interaction`.
 */
export function interactionForUvRect(
  rect: PlanarUvRect,
  frameBounds: UvBounds,
  viewport: { width: number; height: number },
): PlanarInteraction {
  const frameWidth = frameBounds[1] - frameBounds[0];
  const frameHeight = frameBounds[3] - frameBounds[2];
  const rectWidth = rect.u_max_m - rect.u_min_m;
  const rectHeight = rect.v_max_m - rect.v_min_m;
  if (
    !(viewport.width > 0 && viewport.height > 0) ||
    !(frameWidth > 0 && frameHeight > 0) ||
    !(rectWidth > 0 || rectHeight > 0)
  ) {
    return { panU: 0, panV: 0, zoom: 1 };
  }
  const zoom = Math.min(
    rectWidth > 0 ? frameWidth / rectWidth : Number.POSITIVE_INFINITY,
    rectHeight > 0 ? frameHeight / rectHeight : Number.POSITIVE_INFINITY,
  );
  return {
    panU: (rect.u_min_m + rect.u_max_m) / 2 - (frameBounds[0] + frameBounds[1]) / 2,
    panV: (rect.v_min_m + rect.v_max_m) / 2 - (frameBounds[2] + frameBounds[3]) / 2,
    zoom,
  };
}

/** Length, components and angle (degrees from +u, counter-clockwise) of a ruler. */
export function measureSegment(segment: PlanarUvSegment): {
  length_m: number;
  du_m: number;
  dv_m: number;
  angle_deg: number;
} {
  const du = segment.u1_m - segment.u0_m;
  const dv = segment.v1_m - segment.v0_m;
  return {
    angle_deg: (Math.atan2(dv, du) * 180) / Math.PI,
    du_m: du,
    dv_m: dv,
    length_m: Math.hypot(du, dv),
  };
}

/** Intersection with the full frame; null when the rectangle lies outside it. */
export function clipUvRect(rect: PlanarUvRect, bounds: UvBounds): PlanarUvRect | null {
  const clipped = {
    u_min_m: Math.max(rect.u_min_m, bounds[0]),
    u_max_m: Math.min(rect.u_max_m, bounds[1]),
    v_min_m: Math.max(rect.v_min_m, bounds[2]),
    v_max_m: Math.min(rect.v_max_m, bounds[3]),
  };
  return clipped.u_min_m < clipped.u_max_m && clipped.v_min_m < clipped.v_max_m ? clipped : null;
}

/** On-screen size (CSS px) of a rectangle drawn in the visible viewport. */
export function uvRectScreenSize(
  rect: PlanarUvRect,
  viewport: UvBounds,
  canvas: { width: number; height: number },
): { width: number; height: number } {
  const spanU = viewport[1] - viewport[0];
  const spanV = viewport[3] - viewport[2];
  return {
    height: spanV > 0 ? ((rect.v_max_m - rect.v_min_m) / spanV) * canvas.height : 0,
    width: spanU > 0 ? ((rect.u_max_m - rect.u_min_m) / spanU) * canvas.width : 0,
  };
}

/** True when both sides reach `MIN_TOOL_DRAG_PX` on screen. */
export function uvRectLargeEnough(
  rect: PlanarUvRect,
  viewport: UvBounds,
  canvas: { width: number; height: number },
): boolean {
  const size = uvRectScreenSize(rect, viewport, canvas);
  return size.width >= MIN_TOOL_DRAG_PX && size.height >= MIN_TOOL_DRAG_PX;
}

/** Position in percent of the canvas box (left from u, top from v). */
export function uvToCanvasPercent(
  u: number,
  v: number,
  viewport: UvBounds,
): { left: number; top: number } {
  return {
    left: ((u - viewport[0]) / (viewport[1] - viewport[0])) * 100,
    top: ((viewport[3] - v) / (viewport[3] - viewport[2])) * 100,
  };
}

/** Crop rectangle edge or corner grabbed by a resize handle. */
export type PlanarCropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const PLANAR_CROP_HANDLES: readonly PlanarCropHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** Moves the grabbed edges to the pointer and re-normalizes the rectangle. */
export function resizeUvRect(
  rect: PlanarUvRect,
  handle: PlanarCropHandle,
  point: PlanarCursorUv,
): PlanarUvRect {
  const next = { ...rect };
  if (handle.includes("n")) next.v_max_m = point.v_m;
  if (handle.includes("s")) next.v_min_m = point.v_m;
  if (handle.includes("e")) next.u_max_m = point.u_m;
  if (handle.includes("w")) next.u_min_m = point.u_m;
  return normalizeUvRect(
    { u_m: next.u_min_m, v_m: next.v_min_m },
    { u_m: next.u_max_m, v_m: next.v_max_m },
  );
}
