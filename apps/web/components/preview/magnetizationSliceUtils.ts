/**
 * Pure utility functions for MagnetizationSlice2D, extracted into a .ts file
 * so they can be imported by tests without triggering JSX parse issues.
 */

type SlicePlane = "xy" | "xz" | "yz";

export function buildSlice2DChartTopologyKey(
  plane: SlicePlane,
  xLen: number,
  yLen: number,
): string {
  return `${plane}:${xLen}:${yLen}`;
}

export function resolveHeatmapTooltipValue(params: unknown): [number, number, number] | null {
  const source = Array.isArray(params) ? params[0] : params;
  if (!source || typeof source !== "object") return null;
  const value = (source as { value?: unknown }).value;
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const sample = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(sample)) return null;
  return [x, y, sample];
}
