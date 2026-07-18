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
  const x = Math.max(
    0,
    Math.min(
      resolution[0] - 1,
      Math.floor(((u - bounds[0]) / (bounds[1] - bounds[0])) * resolution[0]),
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      resolution[1] - 1,
      Math.floor(((v - bounds[2]) / (bounds[3] - bounds[2])) * resolution[1]),
    ),
  );
  const index = y * resolution[0] + x;
  return {
    index,
    occupancy: mask?.[index] ? "empty" : "occupied",
    value: mask?.[index] ? null : (values[index] ?? null),
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
