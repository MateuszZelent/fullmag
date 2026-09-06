export interface ProbeFrame {
  origin: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

export function localProbe(
  u: number,
  v: number,
  bounds: readonly [number, number, number, number],
  resolution: readonly [number, number],
  values: ArrayLike<number>,
  mask?: ArrayLike<number>,
) {
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < bounds[0] ||
    u > bounds[1] ||
    v < bounds[2] ||
    v > bounds[3]
  ) {
    return {
      index: -1,
      occupancy: "outside_extent",
      value: null,
    };
  }
  const x = Math.min(
    resolution[0] - 1,
    Math.floor(((u - bounds[0]) / (bounds[1] - bounds[0])) * resolution[0]),
  );
  const y = Math.min(
    resolution[1] - 1,
    Math.floor(((v - bounds[2]) / (bounds[3] - bounds[2])) * resolution[1]),
  );
  const index = y * resolution[0] + x;
  const occupancyCode = mask?.[index];
  const renderable = isRenderablePlanarOccupancy(occupancyCode);
  return {
    index,
    occupancy: planarOccupancyLabel(occupancyCode),
    value: renderable ? (values[index] ?? null) : null,
  };
}

export function probeWorldCoordinate(
  u: number,
  v: number,
  frame: ProbeFrame,
): [number, number, number] {
  return [0, 1, 2].map(
    (axis) =>
      frame.origin[axis]! +
      u * frame.uAxis[axis]! +
      v * frame.vAxis[axis]!,
  ) as [number, number, number];
}
import {
  isRenderablePlanarOccupancy,
  planarOccupancyLabel,
} from "./planarOccupancy";
