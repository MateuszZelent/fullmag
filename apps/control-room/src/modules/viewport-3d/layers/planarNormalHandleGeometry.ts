type Vec3 = readonly [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Parameter t of the point on the axis line p + t·n closest to the ray
 * o + s·d (s free). Null when the ray is parallel to the axis, where the
 * drag position along the normal is undefined.
 */
export function closestAxisParameter(
  rayOrigin: Vec3,
  rayDirection: Vec3,
  axisPoint: Vec3,
  axisDirection: Vec3,
): number | null {
  const w: Vec3 = [rayOrigin[0] - axisPoint[0], rayOrigin[1] - axisPoint[1], rayOrigin[2] - axisPoint[2]];
  const a = dot(rayDirection, rayDirection);
  const b = dot(rayDirection, axisDirection);
  const c = dot(axisDirection, axisDirection);
  const denominator = a * c - b * b;
  if (!(Math.abs(denominator) > 1e-12 * a * c)) return null;
  return (a * dot(axisDirection, w) - b * dot(rayDirection, w)) / denominator;
}

/** Centre of the monitor's (u, v) bounds in world coordinates. */
export function planarFrameCenter(
  originM: Vec3,
  uAxis: Vec3,
  vAxis: Vec3,
  boundsUvM: readonly [number, number, number, number],
): [number, number, number] {
  const u = (boundsUvM[0] + boundsUvM[1]) / 2;
  const v = (boundsUvM[2] + boundsUvM[3]) / 2;
  return [0, 1, 2].map((axis) => originM[axis]! + u * uAxis[axis]! + v * vAxis[axis]!) as [number, number, number];
}

/** Origin moved by `distance` along the unit normal. */
export function translateAlongNormal(originM: Vec3, normal: Vec3, distance: number): [number, number, number] {
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return [0, 1, 2].map((axis) => originM[axis]! + (distance * normal[axis]!) / length) as [number, number, number];
}

export interface FrameAxes {
  normal: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
}

const cross = (a: Vec3, b: Vec3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): [number, number, number] => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/**
 * Right-handed orthonormal frame with normal `normal`, keeping `uHint` as
 * close as possible: u = normalize(uHint − (uHint·n)n), v = n × u, so the
 * Inspector's unit/orthogonality/handedness checks (1e-12) hold.
 */
export function orthonormalFrame(normal: Vec3, uHint: Vec3): FrameAxes {
  const n = normalize(normal);
  let u = [uHint[0] - dot(uHint, n) * n[0], uHint[1] - dot(uHint, n) * n[1], uHint[2] - dot(uHint, n) * n[2]] as Vec3;
  if (Math.hypot(u[0], u[1], u[2]) < 1e-9) {
    // Hint parallel to the normal: take the world axis least aligned with it.
    const axis: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    u = cross(cross(n, axis), n);
  }
  const uAxis = normalize(u);
  return { normal: n, uAxis, vAxis: cross(n, uAxis) };
}

/** Rodrigues rotation of `vector` about the unit `axis` by `angle` radians. */
export function rotateAboutAxis(vector: Vec3, axis: Vec3, angle: number): [number, number, number] {
  const k = normalize(axis);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const kxv = cross(k, vector);
  const kdv = dot(k, vector);
  return [0, 1, 2].map((i) => vector[i]! * cos + kxv[i]! * sin + k[i]! * kdv * (1 - cos)) as [number, number, number];
}

/** Frame rotated about `axis` by `angle`, re-orthonormalized. */
export function rotateFrame(frame: FrameAxes, axis: Vec3, angle: number): FrameAxes {
  return orthonormalFrame(rotateAboutAxis(frame.normal, axis, angle), rotateAboutAxis(frame.uAxis, axis, angle));
}

/**
 * Angle of the pointer ray's hit on the plane through `center` with normal
 * `axis`, measured from `e1` towards `e2`; null when the ray is parallel.
 */
export function ringAngle(rayOrigin: Vec3, rayDirection: Vec3, center: Vec3, axis: Vec3, e1: Vec3, e2: Vec3): number | null {
  const denominator = dot(rayDirection, axis);
  if (Math.abs(denominator) < 1e-9 * Math.hypot(...rayDirection)) return null;
  const t = dot([center[0] - rayOrigin[0], center[1] - rayOrigin[1], center[2] - rayOrigin[2]], axis) / denominator;
  const hit: Vec3 = [rayOrigin[0] + t * rayDirection[0] - center[0], rayOrigin[1] + t * rayDirection[1] - center[1], rayOrigin[2] + t * rayDirection[2] - center[2]];
  return Math.atan2(dot(hit, e2), dot(hit, e1));
}
