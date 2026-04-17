export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];
export type AxisConvention = "identity" | "swapYZ";
export type AxisKey = "x" | "y" | "z";

const AXIS_COLORS: Record<AxisKey, string> = {
  x: "#e65050",
  y: "#50c850",
  z: "#5090e6",
};

/** Swap Y↔Z in a 3-element tuple. */
export function swapYZVec3(v: Vec3Tuple): Vec3Tuple {
  return [v[0], v[2], v[1]];
}

/**
 * Convert a quaternion between physical XYZ coordinates and the FDM scene basis
 * where scene-X=physical-X, scene-Y=physical-Z, scene-Z=physical-Y.
 *
 * The basis change is an improper orthogonal transform (it swaps two axes), so
 * the quaternion vector part transforms as det(P) * P * v while the scalar part
 * stays unchanged.
 */
export function swapYZQuat(q: QuatTuple): QuatTuple {
  return [-q[0], -q[2], -q[1], q[3]];
}

export function applyAxisConventionVec3(v: Vec3Tuple, axisConvention: AxisConvention): Vec3Tuple {
  return axisConvention === "swapYZ" ? swapYZVec3(v) : [v[0], v[1], v[2]];
}

export function applyAxisConventionQuat(q: QuatTuple, axisConvention: AxisConvention): QuatTuple {
  return axisConvention === "swapYZ" ? swapYZQuat(q) : [q[0], q[1], q[2], q[3]];
}

export function axisLabelsForConvention(
  axisConvention: AxisConvention,
): [AxisKey, AxisKey, AxisKey] {
  return axisConvention === "swapYZ" ? ["x", "z", "y"] : ["x", "y", "z"];
}

export function sceneAxisDescriptor(
  sceneAxis: 0 | 1 | 2,
  axisConvention: AxisConvention,
): { text: string; color: string } {
  const axisKey = axisLabelsForConvention(axisConvention)[sceneAxis];
  return {
    text: axisKey.toUpperCase(),
    color: AXIS_COLORS[axisKey],
  };
}
