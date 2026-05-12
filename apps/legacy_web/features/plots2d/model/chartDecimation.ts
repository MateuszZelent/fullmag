/**
 * @module features/plots2d/model/chartDecimation
 *
 * Client-side decimation algorithms for scalar time-series.
 *
 * Three modes:
 * - `stride`: simple every-Nth sample (fastest, loses features)
 * - `minmax`: min-max-bucket preserving extrema (best for micromagnetics)
 * - `lttb`: Largest-Triangle-Three-Buckets preserving visual shape
 *
 * For micromagnetics, `minmax` is particularly valuable because it
 * preserves torque spikes, energy jumps, and oscillation extrema.
 *
 * Server-side decimation (Phase 7) will supersede this for large
 * histories (>50k rows), but this remains as a client fallback.
 */

// ─────────────────────────────────────────────────────────────────
// Stride decimation
// ─────────────────────────────────────────────────────────────────

/**
 * Simple stride: keep every N-th sample.
 * Always includes first and last points.
 */
export function decimateStride(
  x: Float64Array | number[],
  columns: Record<string, Float64Array | number[]>,
  maxPoints: number,
): { x: number[]; columns: Record<string, number[]> } {
  const n = x.length;
  if (n <= maxPoints) {
    return {
      x: Array.from(x),
      columns: Object.fromEntries(
        Object.entries(columns).map(([k, v]) => [k, Array.from(v)]),
      ),
    };
  }

  const stride = Math.max(1, Math.floor(n / maxPoints));
  const indices: number[] = [];

  for (let i = 0; i < n; i += stride) {
    indices.push(i);
  }
  // Always include last point
  if (indices[indices.length - 1] !== n - 1) {
    indices.push(n - 1);
  }

  return extractAtIndices(x, columns, indices);
}

// ─────────────────────────────────────────────────────────────────
// Min-max bucket decimation
// ─────────────────────────────────────────────────────────────────

/**
 * Min-max-bucket: divide data into buckets, keep the min and max
 * sample from each bucket. This preserves extrema (critical for
 * torque spikes, energy jumps, oscillation peaks).
 *
 * Output has up to 2 × bucketCount points.
 */
export function decimateMinMaxBucket(
  x: Float64Array | number[],
  y: Float64Array | number[],
  columns: Record<string, Float64Array | number[]>,
  bucketCount: number,
): { x: number[]; columns: Record<string, number[]> } {
  const n = x.length;
  if (n <= bucketCount * 2) {
    return {
      x: Array.from(x),
      columns: Object.fromEntries(
        Object.entries(columns).map(([k, v]) => [k, Array.from(v)]),
      ),
    };
  }

  const bucketSize = n / bucketCount;
  const indices: number[] = [];

  // Always include first point
  indices.push(0);

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(Math.floor((b + 1) * bucketSize), n);
    if (start >= end) continue;

    let minIdx = start;
    let maxIdx = start;
    let minVal = y[start];
    let maxVal = y[start];

    for (let i = start + 1; i < end; i++) {
      const val = y[i];
      if (val < minVal) {
        minVal = val;
        minIdx = i;
      }
      if (val > maxVal) {
        maxVal = val;
        maxIdx = i;
      }
    }

    // Add in temporal order (preserve x-monotonicity)
    if (minIdx <= maxIdx) {
      if (minIdx !== indices[indices.length - 1]) indices.push(minIdx);
      if (maxIdx !== minIdx) indices.push(maxIdx);
    } else {
      if (maxIdx !== indices[indices.length - 1]) indices.push(maxIdx);
      if (minIdx !== maxIdx) indices.push(minIdx);
    }
  }

  // Always include last point
  if (indices[indices.length - 1] !== n - 1) {
    indices.push(n - 1);
  }

  return extractAtIndices(x, columns, indices);
}

// ─────────────────────────────────────────────────────────────────
// LTTB (Largest-Triangle-Three-Buckets)
// ─────────────────────────────────────────────────────────────────

/**
 * LTTB decimation — preserves visual shape of the curve.
 *
 * Reference: Steinarsson, "Downsampling Time Series for Visual
 * Representation", 2013.
 */
export function decimateLTTB(
  x: Float64Array | number[],
  y: Float64Array | number[],
  columns: Record<string, Float64Array | number[]>,
  targetPoints: number,
): { x: number[]; columns: Record<string, number[]> } {
  const n = x.length;
  if (n <= targetPoints || targetPoints < 3) {
    return {
      x: Array.from(x),
      columns: Object.fromEntries(
        Object.entries(columns).map(([k, v]) => [k, Array.from(v)]),
      ),
    };
  }

  const indices: number[] = [];
  indices.push(0); // Always keep first

  const bucketSize = (n - 2) / (targetPoints - 2);

  let prevSelectedIdx = 0;

  for (let bucket = 0; bucket < targetPoints - 2; bucket++) {
    // Current bucket range
    const bucketStart = Math.floor(bucket * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, n - 1);

    // Next bucket range (for average)
    const nextBucketStart = Math.floor((bucket + 1) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, n);

    // Average of next bucket
    let avgX = 0;
    let avgY = 0;
    const nextCount = nextBucketEnd - nextBucketStart;
    for (let i = nextBucketStart; i < nextBucketEnd; i++) {
      avgX += x[i];
      avgY += y[i];
    }
    if (nextCount > 0) {
      avgX /= nextCount;
      avgY /= nextCount;
    }

    // Find point in current bucket with largest triangle area
    let maxArea = -1;
    let maxAreaIdx = bucketStart;

    const ax = x[prevSelectedIdx];
    const ay = y[prevSelectedIdx];

    for (let i = bucketStart; i < bucketEnd; i++) {
      const area = Math.abs(
        (ax - avgX) * (y[i] - ay) - (ax - x[i]) * (avgY - ay),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIdx = i;
      }
    }

    indices.push(maxAreaIdx);
    prevSelectedIdx = maxAreaIdx;
  }

  indices.push(n - 1); // Always keep last

  return extractAtIndices(x, columns, indices);
}

// ─────────────────────────────────────────────────────────────────
// Unified decimation entry point
// ─────────────────────────────────────────────────────────────────

export type DecimationMethod = "none" | "stride" | "minmax" | "lttb";

export interface DecimateOptions {
  method: DecimationMethod;
  maxPoints: number;
  /** Column key to use as the Y reference for minmax/lttb. Defaults to first non-x column. */
  yReferenceKey?: string;
}

/**
 * Decimate a columnar dataset.
 *
 * @param xKey - Column key for the X axis (usually "time" or "step")
 * @param allColumns - All column data including X
 * @param options - Decimation method and target point count
 */
export function decimate(
  xKey: string,
  allColumns: Record<string, Float64Array | number[]>,
  options: DecimateOptions,
): { columns: Record<string, number[]>; method: DecimationMethod; inputRows: number; outputRows: number } {
  const x = allColumns[xKey];
  if (!x || x.length === 0 || options.method === "none" || x.length <= options.maxPoints) {
    return {
      columns: Object.fromEntries(
        Object.entries(allColumns).map(([k, v]) => [k, Array.from(v)]),
      ),
      method: "none",
      inputRows: x?.length ?? 0,
      outputRows: x?.length ?? 0,
    };
  }

  // Separate X from Y columns
  const yColumns: Record<string, Float64Array | number[]> = {};
  for (const [k, v] of Object.entries(allColumns)) {
    if (k !== xKey) yColumns[k] = v;
  }

  // Find the Y reference for area/extrema calculations
  const yRefKey = options.yReferenceKey
    ?? Object.keys(yColumns)[0]
    ?? xKey;
  const yRef = allColumns[yRefKey] ?? x;

  let result: { x: number[]; columns: Record<string, number[]> };

  switch (options.method) {
    case "stride":
      result = decimateStride(x, allColumns, options.maxPoints);
      break;
    case "minmax":
      result = decimateMinMaxBucket(x, yRef, allColumns, Math.floor(options.maxPoints / 2));
      break;
    case "lttb":
      result = decimateLTTB(x, yRef, allColumns, options.maxPoints);
      break;
    default:
      result = decimateStride(x, allColumns, options.maxPoints);
  }

  return {
    columns: result.columns,
    method: options.method,
    inputRows: x.length,
    outputRows: result.columns[xKey]?.length ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────

function extractAtIndices(
  x: Float64Array | number[],
  columns: Record<string, Float64Array | number[]>,
  indices: number[],
): { x: number[]; columns: Record<string, number[]> } {
  const resultX: number[] = new Array(indices.length);
  const resultColumns: Record<string, number[]> = {};

  for (const key of Object.keys(columns)) {
    resultColumns[key] = new Array(indices.length);
  }

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    resultX[i] = x[idx];
    for (const key of Object.keys(columns)) {
      resultColumns[key][i] = columns[key][idx] ?? 0;
    }
  }

  return { x: resultX, columns: resultColumns };
}
