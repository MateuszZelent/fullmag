/**
 * Probe sampling for 2D FEM slices.
 *
 * Point probe works on any `SliceResult` regardless of thickness mode.
 * Renderers call `sampleSliceProbe` with canvas-space coordinates and
 * the current render frame; the probe samples against polygons and
 * segments in the slice result.
 */

import type { Point2 } from "./femSliceGeometry";
import type { SliceResult } from "./femSliceExact";

// ── Types ────────────────────────────────────────────────────────

/** Describes the viewport mapping from canvas pixels to world space. */
export interface SliceRenderFrame {
  width: number;
  height: number;
  margin: { left: number; right: number; top: number; bottom: number };
  plotRect: { x: number; y: number; width: number; height: number };
  colorbarRect: { x: number; y: number; width: number; height: number } | null;
  plotWidth: number;
  plotHeight: number;
  scale: number;
  /** Canvas-X of the left edge of the data bounds. */
  ox: number;
  /** Canvas-Y of the top edge of the data bounds. */
  oy: number;
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
}

/** Result of a point-probe sample. */
export interface SliceProbe {
  canvasX: number;
  canvasY: number;
  /** World-coordinate on the in-plane U axis. */
  u: number;
  /** World-coordinate on the in-plane V axis. */
  v: number;
  /** Sampled scalar value (null if outside mesh). */
  value: number | null;
  /** Where the probe hit. */
  source: "volume" | "boundary" | null;
}

// ── Helpers ──────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function pointInPolygon(point: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / Math.max(yj - yi, 1e-18) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(
  point: Point2,
  a: Point2,
  b: Point2,
): { distance: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = point[0] - a[0];
  const apy = point[1] - a[1];
  const denom = abx * abx + aby * aby;
  if (denom <= 1e-18) return { distance: Math.hypot(apx, apy), t: 0 };
  const t = clamp((apx * abx + apy * aby) / denom, 0, 1);
  const cx = a[0] + abx * t;
  const cy = a[1] + aby * t;
  return { distance: Math.hypot(point[0] - cx, point[1] - cy), t };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Sample the slice at a canvas-space point.
 *
 * Returns `null` if the pointer is outside the plot rect.
 */
export function sampleSliceProbe(
  slice: SliceResult,
  frame: SliceRenderFrame,
  canvasX: number,
  canvasY: number,
): SliceProbe | null {
  const { ox, oy, scale, plotHeight, plotRect, bounds } = frame;
  if (
    canvasX < plotRect.x ||
    canvasX > plotRect.x + plotRect.width ||
    canvasY < plotRect.y ||
    canvasY > plotRect.y + plotRect.height
  ) {
    return null;
  }
  const u = (canvasX - ox) / scale + bounds.uMin;
  const v = (oy + plotHeight - canvasY) / scale + bounds.vMin;
  if (
    !Number.isFinite(u) || !Number.isFinite(v) ||
    u < bounds.uMin || u > bounds.uMax ||
    v < bounds.vMin || v > bounds.vMax
  ) {
    return null;
  }

  const point: Point2 = [u, v];

  // Check volume polygons first
  for (const polygon of slice.polygons) {
    if (polygon.points.length >= 3 && pointInPolygon(point, polygon.points)) {
      return { canvasX, canvasY, u, v, value: polygon.value, source: "volume" };
    }
  }

  // Fall back to boundary segments with snap radius
  const snapRadius = 10 / Math.max(scale, 1e-9);
  let best: SliceProbe | null = null;
  for (const segment of slice.segments) {
    const { distance, t } = distanceToSegment(point, segment.a, segment.b);
    if (distance > snapRadius) continue;
    const value = lerp(segment.va, segment.vb, t);
    if (!best || distance < Math.hypot(best.u - u, best.v - v)) {
      best = { canvasX, canvasY, u, v, value, source: "boundary" };
    }
  }
  return best ?? { canvasX, canvasY, u, v, value: null, source: null };
}

// ── Formatting ───────────────────────────────────────────────────

export function formatProbeValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1e3 || (abs > 0 && abs < 1e-3)) return value.toExponential(2);
  return value.toFixed(4);
}

export function formatMetricLength(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0 m";
  if (abs >= 1) return `${value.toFixed(abs >= 10 ? 2 : 3)} m`;
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(abs >= 1e-2 ? 2 : 3)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(abs >= 1e-5 ? 2 : 3)} µm`;
  if (abs >= 1e-9) return `${(value * 1e9).toFixed(abs >= 1e-8 ? 2 : 3)} nm`;
  return `${value.toExponential(2)} m`;
}
