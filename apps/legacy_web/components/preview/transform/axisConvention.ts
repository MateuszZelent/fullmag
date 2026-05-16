export type Vec3Tuple = [number, number, number];
export type AxisConvention = "identity";
export type AxisKey = "x" | "y" | "z";

const AXIS_COLORS: Record<AxisKey, string> = {
  x: "#e65050",
  y: "#50c850",
  z: "#5090e6",
};

export function applyAxisConventionVec3(v: Vec3Tuple, _axisConvention: AxisConvention): Vec3Tuple {
  return [v[0], v[1], v[2]];
}

export function axisLabelsForConvention(
  _axisConvention: AxisConvention,
): [AxisKey, AxisKey, AxisKey] {
  return ["x", "y", "z"];
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
