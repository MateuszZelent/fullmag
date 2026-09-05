/**
 * Planar 2D view transformation helpers.
 *
 * Provides a single unified coordinate transformation between:
 * - Physical UV space ([u_min, u_max] x [v_min, v_max] in meters)
 * - Raster index / cell space ([0, W] x [0, H] where cells are [col, col+1] and centers are col + 0.5)
 * - Canvas viewport space ([0, canvasWidth] x [0, canvasHeight] in CSS pixels)
 *
 * Eliminates (W - 1) and (H - 1) scaling artifacts (resolves C06 / U01).
 */

/**
 * Maps cell column and row [0..W-1, 0..H-1] to the physical UV center of the cell.
 */
export function rasterCenterToUv(
  col: number,
  row: number,
  resolution: readonly [number, number],
  bounds: readonly [number, number, number, number],
): [number, number] {
  const du = (bounds[1] - bounds[0]) / Math.max(1, resolution[0]);
  const dv = (bounds[3] - bounds[2]) / Math.max(1, resolution[1]);
  return [
    bounds[0] + (col + 0.5) * du,
    bounds[2] + (row + 0.5) * dv,
  ];
}

/**
 * Maps physical UV coordinates to fractional continuous raster coordinates in [0, W] x [0, H].
 */
export function uvToRasterContinuous(
  u: number,
  v: number,
  resolution: readonly [number, number],
  bounds: readonly [number, number, number, number],
): [number, number] {
  const du = Math.max(1e-15, bounds[1] - bounds[0]);
  const dv = Math.max(1e-15, bounds[3] - bounds[2]);
  const x = ((u - bounds[0]) / du) * resolution[0];
  const y = ((v - bounds[2]) / dv) * resolution[1];
  return [x, y];
}

/**
 * Maps physical UV to discrete integer cell index clamped to valid grid bounds.
 * Returns null if UV is outside physical bounds.
 */
export function uvToRasterIndex(
  u: number,
  v: number,
  resolution: readonly [number, number],
  bounds: readonly [number, number, number, number],
): { col: number; row: number; index: number } | null {
  if (u < bounds[0] || u > bounds[1] || v < bounds[2] || v > bounds[3]) {
    return null;
  }
  const [continuousX, continuousY] = uvToRasterContinuous(u, v, resolution, bounds);
  const col = Math.min(resolution[0] - 1, Math.max(0, Math.floor(continuousX)));
  const row = Math.min(resolution[1] - 1, Math.max(0, Math.floor(continuousY)));
  return { col, row, index: row * resolution[0] + col };
}

/**
 * Maps physical UV to canvas pixel coordinates using the active viewport.
 * Note: standard Cartesian mapping (v up -> canvas Y down).
 */
export function uvToCanvas(
  u: number,
  v: number,
  viewport: readonly [number, number, number, number],
  canvasSize: { width: number; height: number },
): [number, number] {
  const spanU = Math.max(1e-15, viewport[1] - viewport[0]);
  const spanV = Math.max(1e-15, viewport[3] - viewport[2]);
  const x = ((u - viewport[0]) / spanU) * canvasSize.width;
  const y = canvasSize.height - ((v - viewport[2]) / spanV) * canvasSize.height;
  return [x, y];
}

/**
 * Maps canvas pixel coordinates to physical UV coordinates using the active viewport.
 */
export function canvasToUv(
  canvasX: number,
  canvasY: number,
  viewport: readonly [number, number, number, number],
  canvasSize: { width: number; height: number },
): [number, number] {
  const spanU = Math.max(1e-15, viewport[1] - viewport[0]);
  const spanV = Math.max(1e-15, viewport[3] - viewport[2]);
  const u = viewport[0] + (canvasX / Math.max(1, canvasSize.width)) * spanU;
  const v = viewport[2] + ((canvasSize.height - canvasY) / Math.max(1, canvasSize.height)) * spanV;
  return [u, v];
}

/**
 * Normalizes viewport to raster cell space [0, W] x [0, H] WITHOUT subtracting 1.
 * This fixes C06 / U01 where multiplying by (W - 1) distorted glyph scales and offsets.
 */
export function viewportToRasterSpace(
  viewport: readonly [number, number, number, number],
  bounds: readonly [number, number, number, number],
  resolution: readonly [number, number],
): [number, number, number, number] {
  const spanU = Math.max(1e-15, bounds[1] - bounds[0]);
  const spanV = Math.max(1e-15, bounds[3] - bounds[2]);
  return [
    ((viewport[0] - bounds[0]) / spanU) * resolution[0],
    ((viewport[1] - bounds[0]) / spanU) * resolution[0],
    ((viewport[2] - bounds[2]) / spanV) * resolution[1],
    ((viewport[3] - bounds[2]) / spanV) * resolution[1],
  ];
}
