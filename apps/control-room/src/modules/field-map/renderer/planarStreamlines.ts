/**
 * In-plane streamlines of one planar vector sample (note 0970,
 * `eq-planar-streamlines`). Presentation only: the curve follows the unit
 * direction of the bilinear interpolant of the frame components (u, v) between
 * pixel centres, integrated by RK4 in physical length. Seeding follows Jobard
 * and Lefer (evenly spaced lines) in a fixed order, so one sample always gives
 * the same lines. Nothing here feeds values, probes or exports.
 */
import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";

export interface PlanarStreamlineInput {
  /** u, v, normal per raster cell, row-major from the minimum v row. */
  vectors: ArrayLike<number>;
  gridWidth: number;
  gridHeight: number;
  /** Physical sample bounds [uMin, uMax, vMin, vMax]. */
  bounds: readonly [number, number, number, number];
  /** Occupancy codes aligned with the raster; non-renderable cells stop lines. */
  mask?: ArrayLike<number> | null;
  /** Line separation d_sep in metres; derived from `budget` when absent. */
  separation?: number;
  /** Target number of glyph-sized cells used to derive d_sep. */
  budget?: number;
  maxLines?: number;
  maxPoints?: number;
}

export interface PlanarStreamlines {
  /** Physical (u, v) pairs of all lines, concatenated. */
  points: Float64Array;
  /** Point offsets per line; line k spans offsets[k] .. offsets[k + 1]. */
  offsets: Uint32Array;
  lineCount: number;
  pointCount: number;
  /** A line or point budget was reached; the set is incomplete. */
  truncated: boolean;
  separation: number;
}

/** Relative in-plane magnitude below which a line stops (ε in the note). */
export const STREAMLINE_MIN_RELATIVE_MAGNITUDE = 1e-3;
/** Collision distance as a fraction of d_sep (d_test = ½ d_sep). */
export const STREAMLINE_TEST_FRACTION = 0.5;
export const STREAMLINE_DEFAULT_MAX_LINES = 4_000;
export const STREAMLINE_DEFAULT_MAX_POINTS = 250_000;
const STREAMLINE_MIN_POINTS = 3;

type Vec2 = [number, number];

export function streamlineSeparation(
  bounds: readonly [number, number, number, number],
  gridWidth: number,
  gridHeight: number,
  budget: number,
): number {
  const lengthU = bounds[1] - bounds[0];
  const lengthV = bounds[3] - bounds[2];
  const pitch = Math.min(lengthU / Math.max(1, gridWidth), lengthV / Math.max(1, gridHeight));
  const fromBudget = Math.sqrt((lengthU * lengthV) / Math.max(1, budget));
  return Math.max(2 * pitch, fromBudget);
}

export function tracePlanarStreamlines(input: PlanarStreamlineInput): PlanarStreamlines {
  const { gridWidth: width, gridHeight: height, bounds, vectors, mask } = input;
  const lengthU = bounds[1] - bounds[0];
  const lengthV = bounds[3] - bounds[2];
  const empty = (separation: number): PlanarStreamlines => ({
    lineCount: 0,
    offsets: new Uint32Array([0]),
    pointCount: 0,
    points: new Float64Array(0),
    separation,
    truncated: false,
  });
  if (
    width < 2 || height < 2 || !(lengthU > 0) || !(lengthV > 0) ||
    vectors.length < width * height * 3
  ) {
    return empty(0);
  }
  const du = lengthU / width;
  const dv = lengthV / height;
  const separation = input.separation && input.separation > 0
    ? input.separation
    : streamlineSeparation(bounds, width, height, input.budget ?? 2_000);
  const testDistance = STREAMLINE_TEST_FRACTION * separation;
  const step = 0.5 * Math.min(du, dv);
  const maxLines = input.maxLines ?? STREAMLINE_DEFAULT_MAX_LINES;
  const maxPoints = input.maxPoints ?? STREAMLINE_DEFAULT_MAX_POINTS;
  const maxPointsPerLine = Math.min(
    maxPoints,
    Math.ceil((4 * (lengthU + lengthV)) / step),
  );

  // Frame components and renderability per cell; NaN marks a stop cell.
  const cellU = new Float64Array(width * height);
  const cellV = new Float64Array(width * height);
  let maxMagnitude = 0;
  for (let index = 0; index < width * height; index += 1) {
    const u = vectors[index * 3]!;
    const v = vectors[index * 3 + 1]!;
    const renderable = !mask || isRenderablePlanarOccupancy(mask[index]);
    if (!renderable || !Number.isFinite(u) || !Number.isFinite(v)) {
      cellU[index] = Number.NaN;
      cellV[index] = Number.NaN;
      continue;
    }
    cellU[index] = u;
    cellV[index] = v;
    const magnitude = Math.hypot(u, v);
    if (magnitude > maxMagnitude) maxMagnitude = magnitude;
  }
  if (!(maxMagnitude > 0)) return empty(separation);
  const minMagnitude = STREAMLINE_MIN_RELATIVE_MAGNITUDE * maxMagnitude;

  /** Unit direction of the bilinear interpolant at (u, v), or null to stop. */
  const direction = (u: number, v: number): Vec2 | null => {
    const fx = (u - bounds[0]) / du - 0.5;
    const fy = (v - bounds[2]) / dv - 0.5;
    if (!(fx >= 0 && fy >= 0 && fx <= width - 1 && fy <= height - 1)) return null;
    const i0 = Math.min(width - 2, Math.floor(fx));
    const j0 = Math.min(height - 2, Math.floor(fy));
    const tx = fx - i0;
    const ty = fy - j0;
    const a = j0 * width + i0;
    const b = a + 1;
    const c = a + width;
    const d = c + 1;
    const wu =
      (1 - tx) * (1 - ty) * cellU[a]! + tx * (1 - ty) * cellU[b]! +
      (1 - tx) * ty * cellU[c]! + tx * ty * cellU[d]!;
    const wv =
      (1 - tx) * (1 - ty) * cellV[a]! + tx * (1 - ty) * cellV[b]! +
      (1 - tx) * ty * cellV[c]! + tx * ty * cellV[d]!;
    // NaN from any corner propagates: a non-renderable corner stops the line.
    const magnitude = Math.hypot(wu, wv);
    if (!(magnitude >= minMagnitude)) return null;
    return [wu / magnitude, wv / magnitude];
  };

  // Spatial hash of accepted points, bucket size d_sep.
  const columns = Math.max(1, Math.ceil(lengthU / separation));
  const rows = Math.max(1, Math.ceil(lengthV / separation));
  const buckets = new Map<number, number[]>();
  // Per stored point: u, v, line id, arc-step index along its line.
  const stored: number[] = [];
  const bucketOf = (u: number, v: number) => {
    const column = Math.min(columns - 1, Math.max(0, Math.floor((u - bounds[0]) / separation)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((v - bounds[2]) / separation)));
    return row * columns + column;
  };
  const insert = (u: number, v: number, line: number, arcIndex: number, touched: Set<number>) => {
    const key = bucketOf(u, v);
    const pointIndex = stored.length / 4;
    stored.push(u, v, line, arcIndex);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(pointIndex);
    touched.add(key);
  };
  // Points of the same line within d_sep of arc length are its own neighbours,
  // not a collision; farther ones closing in to d_test end a loop. A loop of
  // radius below about d_sep / 4 therefore stops instead of winding.
  const ownNeighbourSteps = Math.ceil(separation / step);
  const isFree = (u: number, v: number, distance: number, line = -1, arcIndex = 0) => {
    const column = Math.floor((u - bounds[0]) / separation);
    const row = Math.floor((v - bounds[2]) / separation);
    const distanceSquared = distance * distance;
    for (let r = row - 1; r <= row + 1; r += 1) {
      if (r < 0 || r >= rows) continue;
      for (let c = column - 1; c <= column + 1; c += 1) {
        if (c < 0 || c >= columns) continue;
        const bucket = buckets.get(r * columns + c);
        if (!bucket) continue;
        for (const pointIndex of bucket) {
          const offset = pointIndex * 4;
          if (stored[offset + 2] === line && Math.abs(stored[offset + 3]! - arcIndex) < ownNeighbourSteps) {
            continue;
          }
          const deltaU = stored[offset]! - u;
          const deltaV = stored[offset + 1]! - v;
          if (deltaU * deltaU + deltaV * deltaV < distanceSquared) return false;
        }
      }
    }
    return true;
  };

  const rk4 = (u: number, v: number, signedStep: number): Vec2 | null => {
    const k1 = direction(u, v);
    if (!k1) return null;
    const k2 = direction(u + 0.5 * signedStep * k1[0], v + 0.5 * signedStep * k1[1]);
    if (!k2) return null;
    const k3 = direction(u + 0.5 * signedStep * k2[0], v + 0.5 * signedStep * k2[1]);
    if (!k3) return null;
    const k4 = direction(u + signedStep * k3[0], v + signedStep * k3[1]);
    if (!k4) return null;
    return [
      u + (signedStep / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
      v + (signedStep / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
    ];
  };

  const lines: Float64Array[] = [];
  let totalPoints = 0;
  let truncated = false;

  /** Traces one line from a seed; returns its points or null when too short. */
  const trace = (seedU: number, seedV: number, line: number): Float64Array | null => {
    const touched = new Set<number>();
    const forward: number[] = [];
    const backward: number[] = [];
    insert(seedU, seedV, line, 0, touched);
    let count = 1;
    for (const sign of [1, -1] as const) {
      const target = sign > 0 ? forward : backward;
      let u = seedU;
      let v = seedV;
      for (let arcIndex = sign; ; arcIndex += sign) {
        if (count >= maxPointsPerLine || totalPoints + count >= maxPoints) {
          if (totalPoints + count >= maxPoints) truncated = true;
          break;
        }
        const next = rk4(u, v, sign * step);
        if (!next || !direction(next[0], next[1])) break;
        if (!isFree(next[0], next[1], testDistance, line, arcIndex)) break;
        u = next[0];
        v = next[1];
        target.push(u, v);
        insert(u, v, line, arcIndex, touched);
        count += 1;
      }
    }
    if (count < STREAMLINE_MIN_POINTS) {
      // Too short to draw: withdraw its points so they do not block seeds.
      for (const key of touched) {
        const bucket = buckets.get(key)!;
        buckets.set(key, bucket.filter((pointIndex) => stored[pointIndex * 4 + 2] !== line));
      }
      return null;
    }
    const points = new Float64Array(count * 2);
    let offset = 0;
    for (let index = backward.length - 2; index >= 0; index -= 2) {
      points[offset++] = backward[index]!;
      points[offset++] = backward[index + 1]!;
    }
    points[offset++] = seedU;
    points[offset++] = seedV;
    for (let index = 0; index < forward.length; index += 1) points[offset++] = forward[index]!;
    return points;
  };

  const validSeed = (u: number, v: number) =>
    u >= bounds[0] && u <= bounds[1] && v >= bounds[2] && v <= bounds[3] &&
    direction(u, v) !== null && isFree(u, v, separation);

  let nextLineId = 0;
  const tryLine = (u: number, v: number): boolean => {
    if (lines.length >= maxLines || totalPoints >= maxPoints) {
      truncated = true;
      return false;
    }
    if (!validSeed(u, v)) return false;
    const points = trace(u, v, nextLineId);
    nextLineId += 1;
    if (!points) return false;
    lines.push(points);
    totalPoints += points.length / 2;
    return true;
  };

  // Jobard–Lefer: grow from the neighbourhood of accepted lines first, then
  // take the next free lattice seed when the front is exhausted.
  let queueHead = 0;
  const seedStride = Math.max(1, Math.round(separation / step));
  const growFront = () => {
    while (queueHead < lines.length && !truncated) {
      const points = lines[queueHead]!;
      queueHead += 1;
      const pointCount = points.length / 2;
      for (let index = 0; index < pointCount && !truncated; index += seedStride) {
        const u = points[index * 2]!;
        const v = points[index * 2 + 1]!;
        const tangent = direction(u, v);
        if (!tangent) continue;
        for (const side of [1, -1]) {
          tryLine(u - side * separation * tangent[1], v + side * separation * tangent[0]);
        }
      }
    }
  };
  for (let row = 0; row * separation < lengthV && !truncated; row += 1) {
    for (let column = 0; column * separation < lengthU && !truncated; column += 1) {
      if (tryLine(bounds[0] + (column + 0.5) * separation, bounds[2] + (row + 0.5) * separation)) {
        growFront();
      }
    }
  }

  const offsets = new Uint32Array(lines.length + 1);
  const points = new Float64Array(totalPoints * 2);
  let cursor = 0;
  lines.forEach((line, index) => {
    points.set(line, cursor * 2);
    cursor += line.length / 2;
    offsets[index + 1] = cursor;
  });
  return {
    lineCount: lines.length,
    offsets,
    pointCount: totalPoints,
    points,
    separation,
    truncated,
  };
}
