/**
 * Pure TypeScript mirror of `crates/fullmag-plan/src/magnetization_textures_v2.rs`
 * and `packages/fullmag-py/src/fullmag/init/preset_eval_v2.py`.
 *
 * Zero DOM or Three.js dependencies. Guaranteed < 1e-12 infinity-norm parity
 * across all 20 analytic presets, right-handed plane frames, Hamilton Euler XYZ
 * quaternions, `rotate_vectors`, and all 5 metric `clamp_mode` modes.
 */

import type { TargetMetricBounds, Vec3 } from "./boundsResolver";

export type Quat4 = [number, number, number, number];
export type TextureProjectionModeV2 =
  | "object_local"
  | "planar_xy"
  | "planar_xz"
  | "planar_yz";
export type TextureClampModeV2 =
  | "none"
  | "clamp"
  | "repeat"
  | "mirror"
  | "background";
export type TextureMappingSpaceMode = "object" | "region" | "world";
export type TextureAxisExtentModeV2 = "uniform" | "thickness";

export interface TextureMappingSpecV2 {
  space?: TextureMappingSpaceMode | string;
  projection?: TextureProjectionModeV2 | string;
  clamp_mode?: TextureClampModeV2 | string;
  tile_period?: readonly [number, number, number] | null;
  background_vector?: readonly [number, number, number] | null;
  axis_extent_mode?: TextureAxisExtentModeV2 | string | null;
  axis_thickness_m?: number | null;
}

export interface TextureTransform3DSpecV2 {
  translation?: readonly [number, number, number];
  rotation_quat?: readonly [number, number, number, number];
  scale?: readonly [number, number, number];
  pivot?: readonly [number, number, number];
  rotate_vectors?: boolean;
}

export interface PresetTextureSpecV2 {
  preset_kind: string;
  preset_version?: number;
  preset_params?: Record<string, unknown>;
  mapping?: TextureMappingSpecV2;
  texture_transform?: TextureTransform3DSpecV2;
}

export interface TextureSampleCoordinate {
  positionObject: Vec3;
  positionRegion?: Vec3 | null;
  positionWorld?: Vec3 | null;
}

const EPSILON = 1.0e-14;
const U64_MASK = BigInt("0xffffffffffffffff");
const SPLITMIX_GAMMA = BigInt("0x9e3779b97f4a7c15");
const SPLITMIX_MUL1 = BigInt("0xbf58476d1ce4e5b9");
const SPLITMIX_MUL2 = BigInt("0x94d049bb133111eb");
const SHIFT_30 = BigInt(30);
const SHIFT_27 = BigInt(27);
const SHIFT_31 = BigInt(31);
const SHIFT_11 = BigInt(11);
const U64_TO_UNIT_F64 = 1.0 / 9007199254740992.0;
const TAU = 2.0 * Math.PI;
const FRAC_PI_2 = 0.5 * Math.PI;
const FRAC_PI_4 = 0.25 * Math.PI;
const SQRT_3 = Math.sqrt(3.0);

const F64_BIT_BUFFER = new ArrayBuffer(8);
const F64_BIT_VIEW = new DataView(F64_BIT_BUFFER);

const METRIC_PRESETS = new Set<string>([
  "vortex",
  "antivortex",
  "vortex_wall",
  "bloch_skyrmion",
  "neel_skyrmion",
  "antiskyrmion",
  "skyrmionium",
  "bimeron",
  "domain_wall",
  "two_domain",
  "skyrmion_lattice",
  "artificial_spin_ice",
]);

const THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS = new Set<string>([
  "hopfion",
  "hopfion_compact_support",
  "bloch_point",
]);

function invalid(key: string, reason: string): Error {
  return new Error(`invalid preset parameter '${key}': ${reason}`);
}

function finiteNumber(
  params: Record<string, unknown>,
  key: string,
  defaultValue?: number,
): number {
  const raw = params[key] !== undefined ? params[key] : defaultValue;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw invalid(key, raw === undefined ? "parameter is required" : "must be a finite number");
  }
  return raw;
}

function positive(
  params: Record<string, unknown>,
  key: string,
  defaultValue?: number,
): number {
  const val = finiteNumber(params, key, defaultValue);
  if (val <= 0.0) {
    throw invalid(key, "must be positive");
  }
  return val;
}

function integer(
  params: Record<string, unknown>,
  key: string,
  defaultValue?: number,
): number {
  const raw = params[key] !== undefined ? params[key] : defaultValue;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalid(key, raw === undefined ? "parameter is required" : "must be an integer");
  }
  return raw;
}

function signParam(
  params: Record<string, unknown>,
  key: string,
  defaultValue = 1,
): number {
  const val = integer(params, key, defaultValue);
  if (val !== -1 && val !== 1) {
    throw invalid(key, "must be either -1 or 1");
  }
  return val;
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
  defaultValue?: string,
): string {
  const raw = params[key] !== undefined ? params[key] : defaultValue;
  if (typeof raw !== "string") {
    throw invalid(key, raw === undefined ? "parameter is required" : "must be a string");
  }
  return raw;
}

function vectorParam(
  params: Record<string, unknown>,
  key: string,
  defaultValue?: readonly [number, number, number],
): Vec3 {
  const raw = params[key] !== undefined ? params[key] : defaultValue;
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw invalid(key, raw === undefined ? "parameter is required" : "must be a 3-element array");
  }
  const c0 = raw[0];
  const c1 = raw[1];
  const c2 = raw[2];
  if (
    typeof c0 !== "number" ||
    typeof c1 !== "number" ||
    typeof c2 !== "number" ||
    !Number.isFinite(c0) ||
    !Number.isFinite(c1) ||
    !Number.isFinite(c2)
  ) {
    throw invalid(key, "all components must be finite");
  }
  return [c0, c1, c2];
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function add(a: readonly [number, number, number], b: readonly [number, number, number]): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: readonly [number, number, number], b: readonly [number, number, number]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVec(v: readonly [number, number, number], factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

function norm(v: readonly [number, number, number]): number {
  return Math.sqrt(dot(v, v));
}

function normalizeChecked(v: readonly [number, number, number], key: string): Vec3 {
  if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) {
    throw invalid(key, "all components must be finite");
  }
  const length = norm(v);
  if (!Number.isFinite(length) || length <= EPSILON) {
    throw invalid(key, "vector must be nonzero and normalizable");
  }
  return scaleVec(v, 1.0 / length);
}

export interface OrientedPlaneFrame {
  e_u: Vec3;
  e_v: Vec3;
  e_n: Vec3;
}

export function orientedPlaneFrame(plane: string): OrientedPlaneFrame {
  switch (plane) {
    case "xy":
      return { e_u: [1, 0, 0], e_v: [0, 1, 0], e_n: [0, 0, 1] };
    case "xz":
      return { e_u: [1, 0, 0], e_v: [0, 0, 1], e_n: [0, -1, 0] };
    case "yz":
      return { e_u: [0, 1, 0], e_v: [0, 0, 1], e_n: [1, 0, 0] };
    default:
      throw invalid("plane", `unknown plane '${plane}'`);
  }
}

function projectionPlane(projection?: string | null): string | null {
  switch (projection) {
    case "planar_xy":
      return "xy";
    case "planar_xz":
      return "xz";
    case "planar_yz":
      return "yz";
    case "object_local":
    case undefined:
    case null:
    case "":
      return null;
    default:
      throw invalid("projection", `unsupported projection '${projection}'`);
  }
}

function resolveFrame(
  params: Record<string, unknown>,
  projection?: string | null,
): OrientedPlaneFrame | null {
  const explicit = params.plane !== undefined ? stringParam(params, "plane") : null;
  const projected = projectionPlane(projection);
  if (explicit !== null && projected !== null && explicit !== projected) {
    throw new Error(
      `preset plane '${explicit}' conflicts with mapping projection '${projected}'`,
    );
  }
  const selected = explicit ?? projected;
  return selected !== null ? orientedPlaneFrame(selected) : null;
}

function frameCoordinates(point: Vec3, frame: OrientedPlaneFrame): Vec3 {
  return [dot(point, frame.e_u), dot(point, frame.e_v), dot(point, frame.e_n)];
}

function frameVectorToWorld(vector: Vec3, frame: OrientedPlaneFrame): Vec3 {
  return add(
    add(scaleVec(frame.e_u, vector[0]), scaleVec(frame.e_v, vector[1])),
    scaleVec(frame.e_n, vector[2]),
  );
}

export function normalizeQuaternion(
  quaternion: readonly [number, number, number, number],
): Quat4 {
  if (
    quaternion.length !== 4 ||
    quaternion.some((c) => typeof c !== "number" || !Number.isFinite(c))
  ) {
    throw invalid("texture_transform.rotation_quat", "must have four finite components");
  }
  const len = Math.sqrt(
    quaternion[0] * quaternion[0] +
      quaternion[1] * quaternion[1] +
      quaternion[2] * quaternion[2] +
      quaternion[3] * quaternion[3],
  );
  if (!Number.isFinite(len) || len <= EPSILON) {
    throw invalid("texture_transform.rotation_quat", "quaternion must be nonzero and finite");
  }
  return [
    quaternion[0] / len,
    quaternion[1] / len,
    quaternion[2] / len,
    quaternion[3] / len,
  ];
}

export function multiplyQuaternions(a: Quat4, b: Quat4): Quat4 {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return normalizeQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

/**
 * Canonical extrinsic XYZ Euler angles [deg] -> Hamilton unit quaternion [qx, qy, qz, qw]:
 * q = q_z(theta_z) (x) q_y(theta_y) (x) q_x(theta_x), matching R = R_z * R_y * R_x.
 */
export function eulerDegreesToQuaternion(eulerDeg: readonly [number, number, number]): Quat4 {
  const hx = ((eulerDeg[0] * Math.PI) / 180.0) * 0.5;
  const hy = ((eulerDeg[1] * Math.PI) / 180.0) * 0.5;
  const hz = ((eulerDeg[2] * Math.PI) / 180.0) * 0.5;
  const cx = Math.cos(hx);
  const sx = Math.sin(hx);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cz = Math.cos(hz);
  const sz = Math.sin(hz);
  return normalizeQuaternion([
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ]);
}

/**
 * Inverse of `eulerDegreesToQuaternion` for R = R_z(yaw) * R_y(pitch) * R_x(roll),
 * preserving `previousEulerDeg[2]` continuously at the +/-90 deg gimbal singularity.
 */
export function quaternionToEulerDegrees(
  quaternion: readonly [number, number, number, number],
  previousEulerDeg?: readonly [number, number, number],
): Vec3 {
  const [x, y, z, w] = normalizeQuaternion(quaternion);
  const sinPitch = Math.max(-1.0, Math.min(1.0, 2.0 * (w * y - x * z)));
  const pitch = Math.asin(sinPitch);
  let roll: number;
  let yaw: number;
  if (Math.abs(sinPitch) >= 1.0 - 1e-7) {
    yaw = ((previousEulerDeg?.[2] ?? 0) * Math.PI) / 180.0;
    const r01 = 2.0 * (x * y - w * z);
    const r11 = 1.0 - 2.0 * (x * x + z * z);
    if (sinPitch > 0) {
      roll = yaw + Math.atan2(r01, r11);
    } else {
      roll = -yaw + Math.atan2(-r01, r11);
    }
  } else {
    roll = Math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
    yaw = Math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
  }
  const radToDeg = 180.0 / Math.PI;
  const cleanZero = (deg: number) => (Math.abs(deg) < 1e-12 ? 0 : deg);
  return [cleanZero(roll * radToDeg), cleanZero(pitch * radToDeg), cleanZero(yaw * radToDeg)];
}

export function axisAngleToQuaternion(
  axis: readonly [number, number, number],
  angleDeg: number,
): Quat4 {
  const u = normalizeChecked(axis, "axis");
  const halfRad = ((angleDeg * Math.PI) / 180.0) * 0.5;
  const s = Math.sin(halfRad);
  return normalizeQuaternion([u[0] * s, u[1] * s, u[2] * s, Math.cos(halfRad)]);
}

export function quaternionToAxisAngle(
  quaternion: readonly [number, number, number, number],
): { axis: Vec3; angleDeg: number } {
  const [qx, qy, qz, qw] = normalizeQuaternion(quaternion);
  const signW = qw < 0 ? -1 : 1;
  const x = qx * signW;
  const y = qy * signW;
  const z = qz * signW;
  const w = Math.min(1.0, Math.max(-1.0, qw * signW));
  const sinHalf = Math.hypot(x, y, z);
  if (sinHalf <= 1e-9) {
    return { axis: [0, 0, 1], angleDeg: 0 };
  }
  const angleRad = 2.0 * Math.atan2(sinHalf, w);
  return {
    axis: [x / sinHalf, y / sinHalf, z / sinHalf],
    angleDeg: (angleRad * 180.0) / Math.PI,
  };
}

export function rotateVectorByQuaternion(
  vector: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
): Vec3 {
  const q: Vec3 = [quaternion[0], quaternion[1], quaternion[2]];
  const t = scaleVec(cross(q, vector), 2.0);
  return add(add(vector, scaleVec(t, quaternion[3])), cross(q, t));
}

interface PreparedTextureTransform {
  translation: Vec3;
  pivot: Vec3;
  inverseScale: Vec3;
  rotation: Quat4;
  inverseRotation: Quat4;
  rotateVectors: boolean;
}

function prepareTransform(spec?: TextureTransform3DSpecV2): PreparedTextureTransform {
  const translation: Vec3 = spec?.translation
    ? [spec.translation[0], spec.translation[1], spec.translation[2]]
    : [0, 0, 0];
  const scale: Vec3 = spec?.scale ? [spec.scale[0], spec.scale[1], spec.scale[2]] : [1, 1, 1];
  const pivot: Vec3 = spec?.pivot ? [spec.pivot[0], spec.pivot[1], spec.pivot[2]] : [0, 0, 0];
  const rawQuat: readonly [number, number, number, number] = spec?.rotation_quat ?? [0, 0, 0, 1];

  if (
    [...translation, ...scale, ...pivot, ...rawQuat].some(
      (c) => typeof c !== "number" || !Number.isFinite(c),
    )
  ) {
    throw invalid("texture_transform", "all components must be finite");
  }
  if (scale.some((s) => Math.abs(s) <= EPSILON)) {
    throw invalid("texture_transform.scale", "all components must be nonzero");
  }
  const rotation = normalizeQuaternion(rawQuat);
  return {
    translation,
    pivot,
    inverseScale: [1.0 / scale[0], 1.0 / scale[1], 1.0 / scale[2]],
    rotation,
    inverseRotation: [-rotation[0], -rotation[1], -rotation[2], rotation[3]],
    rotateVectors: spec?.rotate_vectors !== false,
  };
}

function pointToTexture(transform: PreparedTextureTransform, point: Vec3): Vec3 {
  const shifted = sub(sub(point, transform.translation), transform.pivot);
  const rotated = rotateVectorByQuaternion(shifted, transform.inverseRotation);
  return [
    rotated[0] * transform.inverseScale[0] + transform.pivot[0],
    rotated[1] * transform.inverseScale[1] + transform.pivot[1],
    rotated[2] * transform.inverseScale[2] + transform.pivot[2],
  ];
}

function vectorToSource(transform: PreparedTextureTransform, vector: Vec3): Vec3 {
  return transform.rotateVectors
    ? rotateVectorByQuaternion(vector, transform.rotation)
    : vector;
}

function splitmix64(state: bigint): bigint {
  const s = (state + SPLITMIX_GAMMA) & U64_MASK;
  let result = s;
  result = ((result ^ (result >> SHIFT_30)) * SPLITMIX_MUL1) & U64_MASK;
  result = ((result ^ (result >> SHIFT_27)) * SPLITMIX_MUL2) & U64_MASK;
  return (result ^ (result >> SHIFT_31)) & U64_MASK;
}

function unitFromU64(value: bigint): number {
  return Number(value >> SHIFT_11) * U64_TO_UNIT_F64;
}

function f64ToBits(value: number): bigint {
  F64_BIT_VIEW.setFloat64(0, value, true);
  return F64_BIT_VIEW.getBigUint64(0, true);
}

function randomUnitVector(seed: number, point: Vec3): Vec3 {
  let state = splitmix64(BigInt(seed) & U64_MASK);
  for (const component of point) {
    state = splitmix64(state ^ f64ToBits(component));
  }
  const phiHash = splitmix64(state);
  const cosHash = splitmix64(phiHash);
  const phi = unitFromU64(phiHash) * TAU;
  const cosTheta = unitFromU64(cosHash) * 2.0 - 1.0;
  const sinTheta = Math.sqrt(Math.max(0.0, 1.0 - cosTheta * cosTheta));
  return [sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta];
}

function logSinh(value: number): number {
  if (value <= 0.0) return Number.NEGATIVE_INFINITY;
  if (value < 1.0e-5) return Math.log(value);
  return value - Math.LN2 + Math.log1p(-Math.exp(-2.0 * value));
}

function skyrmionTheta(radius: number, distance: number, wallWidth: number): number {
  if (distance <= EPSILON) return Math.PI;
  const logRatio = logSinh(radius / wallWidth) - logSinh(distance / wallWidth);
  if (logRatio > 40.0) return Math.PI;
  if (logRatio < -40.0) return 0.0;
  return 2.0 * Math.atan(Math.exp(logRatio));
}

function wallHelicity(kind: "bloch" | "neel", chirality: number): number {
  if (kind === "bloch") return chirality * FRAC_PI_2;
  return chirality > 0.0 ? 0.0 : Math.PI;
}

function evalVortex(
  params: Record<string, unknown>,
  point: Vec3,
  vorticity: number,
): Vec3 {
  const circulation = signParam(params, "circulation", 1);
  const polarity = signParam(params, "core_polarity", 1);
  const coreRadius = positive(params, "core_radius", 1.0e-9);
  const radius = Math.hypot(point[0], point[1]);
  const phi = Math.atan2(point[1], point[0]);
  const ratio = radius / coreRadius;
  const core = Math.exp(-(ratio * ratio));
  const transverse = Math.sqrt(Math.max(0.0, 1.0 - core * core));
  const phase = vorticity * phi + circulation * FRAC_PI_2;
  return [transverse * Math.cos(phase), transverse * Math.sin(phase), polarity * core];
}

function evalSkyrmion(
  params: Record<string, unknown>,
  point: Vec3,
  winding: number,
  wallType: "bloch" | "neel",
): Vec3 {
  const radius = positive(params, "radius");
  const wallWidth = positive(params, "wall_width");
  const polarity = signParam(params, "core_polarity", 1);
  const chirality = signParam(params, "chirality", 1);
  const distance = Math.hypot(point[0], point[1]);
  const phi = Math.atan2(point[1], point[0]);
  const theta = skyrmionTheta(radius, distance, wallWidth);
  const phase = winding * phi + wallHelicity(wallType, chirality);
  const sinTheta = Math.sin(theta);
  return [sinTheta * Math.cos(phase), sinTheta * Math.sin(phase), -polarity * Math.cos(theta)];
}

function evalSkyrmionium(params: Record<string, unknown>, point: Vec3): Vec3 {
  const innerRadius = positive(params, "inner_radius");
  const outerRadius = positive(params, "outer_radius");
  if (outerRadius <= innerRadius) {
    throw invalid("outer_radius", "must be greater than inner_radius");
  }
  const wallWidth = positive(params, "wall_width");
  const chirality = signParam(params, "chirality", 1);
  const background = signParam(params, "background_sign", 1);
  const kind = stringParam(params, "kind", "neel");
  if (kind !== "bloch" && kind !== "neel") {
    throw invalid("kind", "must be either 'bloch' or 'neel'");
  }
  const distance = Math.hypot(point[0], point[1]);
  const wallAngle = (coord: number) => Math.acos(-Math.tanh(coord));
  const theta =
    wallAngle((distance - innerRadius) / wallWidth) +
    wallAngle((distance - outerRadius) / wallWidth);
  const phase = Math.atan2(point[1], point[0]) + wallHelicity(kind, chirality);
  const sinTheta = Math.sin(theta);
  return [sinTheta * Math.cos(phase), sinTheta * Math.sin(phase), background * Math.cos(theta)];
}

function evalHopfion(params: Record<string, unknown>, point: Vec3): Vec3 {
  const radius = positive(params, "radius");
  const charge = signParam(params, "hopf_charge", 1);
  const background = signParam(params, "background_sign", 1);
  const axialScale = positive(params, "axial_scale", 1.0);
  const phase = finiteNumber(params, "phase_rad", 0.0);

  const x = point[0] / radius;
  const y = (charge * point[1]) / radius;
  const z = point[2] / (radius * axialScale);
  const rhoSq = x * x + y * y + z * z;
  if (!Number.isFinite(rhoSq)) {
    return [0.0, 0.0, background];
  }
  const denominator = 1.0 + rhoSq;
  const z1Re = (2.0 * x) / denominator;
  const z1Im = (2.0 * y) / denominator;
  const z2Re = (2.0 * z) / denominator;
  const z2Im = (rhoSq - 1.0) / denominator;

  const hopfX = 2.0 * (z1Re * z2Re + z1Im * z2Im);
  const hopfY = 2.0 * (z1Im * z2Re - z1Re * z2Im);
  const hopfZ = z1Re * z1Re + z1Im * z1Im - z2Re * z2Re - z2Im * z2Im;
  const rotX = Math.cos(phase) * hopfX - Math.sin(phase) * hopfY;
  const rotY = Math.sin(phase) * hopfX + Math.cos(phase) * hopfY;
  return normalizeChecked(scaleVec([rotX, rotY, hopfZ], -background), "hopfion");
}

function evalVortexWall(params: Record<string, unknown>, point: Vec3): Vec3 {
  const wallHalfWidth = positive(params, "wall_half_width");
  const leftMx = finiteNumber(params, "left_mx", 1.0);
  const rightMx = finiteNumber(params, "right_mx", -1.0);
  if (leftMx === 0.0) throw invalid("left_mx", "must be finite and nonzero");
  if (rightMx === 0.0) throw invalid("right_mx", "must be finite and nonzero");
  if (point[0] < -wallHalfWidth) return [leftMx > 0 ? 1.0 : -1.0, 0.0, 0.0];
  if (point[0] > wallHalfWidth) return [rightMx > 0 ? 1.0 : -1.0, 0.0, 0.0];
  if (params.circulation === undefined) {
    const derivedCirculation = leftMx * rightMx > 0.0 ? 1 : -1;
    return evalVortex({ ...params, circulation: derivedCirculation }, point, 1.0);
  }
  return evalVortex(params, point, 1.0);
}

function evalHopfionCompactSupport(params: Record<string, unknown>, point: Vec3): Vec3 {
  const majorRadius = positive(params, "major_radius");
  const minorRadius = positive(params, "minor_radius");
  if (minorRadius > majorRadius) {
    throw invalid("minor_radius", "minor_radius must be <= major_radius");
  }
  const psi = Math.atan2(point[1], point[0]);
  const toroidalRadial = point[0] * Math.cos(psi) + point[1] * Math.sin(psi) - majorRadius;
  const rho = Math.hypot(point[2], toroidalRadial);
  if (rho >= minorRadius) {
    return [0.0, 0.0, 1.0];
  }
  const localPhi = Math.atan2(point[2], toroidalRadial);
  const phi = -localPhi + psi;
  const normR = rho / minorRadius;
  const compactDen = 1.0 - normR * normR;
  const theta = Math.PI * Math.exp(1.0 - 1.0 / compactDen);
  return [Math.cos(phi) * Math.sin(theta), Math.sin(phi) * Math.sin(theta), Math.cos(theta)];
}

function axisVector(axis: string): Vec3 {
  switch (axis) {
    case "x":
      return [1, 0, 0];
    case "y":
      return [0, 1, 0];
    case "z":
      return [0, 0, 1];
    default:
      throw invalid("normal_axis", `unknown axis '${axis}'`);
  }
}

function stableSech(value: number): number {
  if (Math.abs(value) > 350.0) return 0.0;
  return 1.0 / Math.cosh(value);
}

export function fallbackDomainWallDirection(axis: Vec3, left: Vec3, kind: string): Vec3 {
  const projected = sub(axis, scaleVec(left, dot(axis, left)));
  const preferred = kind === "neel" ? projected : cross(axis, left);
  if (norm(preferred) > EPSILON) {
    return normalizeChecked(preferred, "wall_center_direction");
  }
  const helper: Vec3 =
    Math.abs(axis[0]) < 0.9
      ? [1, 0, 0]
      : Math.abs(axis[1]) < 0.9
        ? [0, 1, 0]
        : [0, 0, 1];
  const tangentOne = normalizeChecked(cross(axis, helper), "wall_center_direction");
  return kind === "bloch"
    ? tangentOne
    : normalizeChecked(cross(tangentOne, axis), "wall_center_direction");
}

function evalDomainWall(params: Record<string, unknown>, point: Vec3): Vec3 {
  const axisName = stringParam(params, "normal_axis", "x");
  const axis = axisVector(axisName);
  const coordinate = dot(point, axis);
  const center = finiteNumber(params, "center_offset", 0.0);
  const width = positive(params, "width");
  const left = normalizeChecked(vectorParam(params, "left", [1, 0, 0]), "left");
  const right = normalizeChecked(vectorParam(params, "right", [-1, 0, 0]), "right");
  if (dot(left, right) > -1.0 + 1.0e-10) {
    throw invalid("right", "v2 domain wall requires an antiparallel right domain");
  }
  const kind = stringParam(params, "kind", "neel");
  if (kind !== "neel" && kind !== "bloch") {
    throw invalid("kind", "must be either 'bloch' or 'neel'");
  }
  const rawWallDir =
    params.wall_center_direction !== undefined
      ? vectorParam(params, "wall_center_direction")
      : fallbackDomainWallDirection(axis, left, kind);
  const wallDir = normalizeChecked(rawWallDir, "wall_center_direction");
  if (Math.abs(dot(wallDir, left)) > 1.0e-10) {
    throw invalid("wall_center_direction", "must be orthogonal to the domain direction");
  }
  const xi = (coordinate - center) / width;
  const mixed = add(scaleVec(left, -Math.tanh(xi)), scaleVec(wallDir, stableSech(xi)));
  return normalizeChecked(mixed, "domain_wall");
}

function evalTwoDomain(params: Record<string, unknown>, point: Vec3): Vec3 {
  const axis = axisVector(stringParam(params, "normal_axis", "x"));
  const coordinate = dot(point, axis);
  const left = normalizeChecked(vectorParam(params, "left"), "left");
  const right = normalizeChecked(vectorParam(params, "right"), "right");
  const wall = normalizeChecked(vectorParam(params, "wall"), "wall");
  if (params.sharp !== undefined) {
    if (params.sharp === true) {
      if (coordinate < 0.0) return left;
      if (coordinate > 0.0) return right;
      return wall;
    }
    if (params.sharp !== false) {
      throw invalid("sharp", "must be boolean");
    }
  }
  const width = positive(params, "wall_width");
  const t = 0.5 * (Math.tanh(coordinate / width) + 1.0);
  const mixed = add(scaleVec(left, 1.0 - t), scaleVec(right, t));
  if (norm(mixed) <= EPSILON) return wall;
  return normalizeChecked(mixed, "two_domain");
}

function evalHelical(params: Record<string, unknown>, point: Vec3): Vec3 {
  const rawQ = vectorParam(params, "wavevector");
  const qHat = normalizeChecked(rawQ, "wavevector");
  const magnitude = norm(rawQ);
  const e1 = normalizeChecked(vectorParam(params, "e1", [1, 0, 0]), "e1");
  const e2 = normalizeChecked(vectorParam(params, "e2", [0, 1, 0]), "e2");
  if (Math.abs(dot(e1, e2)) > 1.0e-12) {
    throw invalid("e2", "e1 and e2 must be orthogonal");
  }
  const phase = dot(point, scaleVec(qHat, magnitude)) + finiteNumber(params, "phase_rad", 0.0);
  return add(scaleVec(e1, Math.cos(phase)), scaleVec(e2, Math.sin(phase)));
}

function evalConical(params: Record<string, unknown>, point: Vec3): Vec3 {
  const wavevector = vectorParam(params, "wavevector");
  const magnitude = norm(wavevector);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) {
    throw invalid("wavevector", "must be nonzero and finite");
  }
  const axis = normalizeChecked(vectorParam(params, "cone_axis", [0, 0, 1]), "cone_axis");
  const angle = finiteNumber(params, "cone_angle_rad", FRAC_PI_4);
  if (angle < 0.0 || angle > Math.PI) {
    throw invalid("cone_angle_rad", "must lie in [0, pi]");
  }
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalizeChecked(cross(axis, helper), "cone_axis");
  const e2 = cross(axis, e1);
  const phase = dot(point, wavevector) + finiteNumber(params, "phase_rad", 0.0);
  const transverse = add(scaleVec(e1, Math.cos(phase)), scaleVec(e2, Math.sin(phase)));
  return add(scaleVec(axis, Math.cos(angle)), scaleVec(transverse, Math.sin(angle)));
}

function evalBimeron(params: Record<string, unknown>, point: Vec3): Vec3 {
  const radius = positive(params, "radius");
  const width = positive(params, "wall_width");
  const vorticity = signParam(params, "vorticity", 1);
  const helicity = finiteNumber(params, "helicity_rad", 0.0);
  const background = signParam(params, "background_sign", 1);
  const distance = Math.hypot(point[0], point[1]);
  const theta =
    Math.asin(Math.tanh((distance - radius) / width)) +
    Math.asin(Math.tanh((distance + radius) / width));
  const phase = vorticity * Math.atan2(point[1], point[0]) + helicity;
  return [
    -background * Math.cos(theta),
    -background * Math.sin(theta) * Math.sin(phase),
    -background * Math.sin(theta) * Math.cos(phase),
  ];
}

function remEuclid(value: number, modulus: number): number {
  const r = value % modulus;
  return r < 0 ? r + modulus : r;
}

function wrapMetricRepeat(coord: number, period: number): number {
  return remEuclid(coord + 0.5 * period, period) - 0.5 * period;
}

function wrapMetricMirror(coord: number, period: number): number {
  const twoP = 2.0 * period;
  const wrapped = remEuclid(coord + 0.5 * period, twoP);
  const folded = wrapped <= period ? wrapped : twoP - wrapped;
  return folded - 0.5 * period;
}

function orthonormalBasisFromNormal(normal: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalizeChecked(cross(ref, normal), "spin_plane_normal");
  const e2 = normalizeChecked(cross(normal, e1), "spin_plane_normal");
  return [e1, e2];
}

function evalSkyrmionLattice(params: Record<string, unknown>, point: Vec3): Vec3 {
  const lattice = stringParam(params, "lattice", "hexagonal");
  const a = positive(params, "lattice_constant");
  const radius = positive(params, "radius");
  if (a <= 2.0 * radius) {
    throw invalid("lattice_constant", "must be strictly greater than 2 * radius");
  }
  const wallType = stringParam(params, "kind", "bloch");
  if (wallType !== "bloch" && wallType !== "neel") {
    throw invalid("kind", `must be 'bloch' or 'neel', got '${wallType}'`);
  }
  let uWs: number;
  let vWs: number;
  if (lattice === "square") {
    uWs = wrapMetricRepeat(point[0], a);
    vWs = wrapMetricRepeat(point[1], a);
  } else if (lattice === "hexagonal") {
    const sqrt3HalfA = 0.5 * SQRT_3 * a;
    const f2 = point[1] / sqrt3HalfA;
    const f1 = (point[0] - 0.5 * a * f2) / a;
    const n1_0 = Math.round(f1);
    const n2_0 = Math.round(f2);
    let bestDistSq = Number.POSITIVE_INFINITY;
    uWs = point[0];
    vWs = point[1];
    for (let d1 = -1; d1 <= 1; d1 += 1) {
      for (let d2 = -1; d2 <= 1; d2 += 1) {
        const n1 = n1_0 + d1;
        const n2 = n2_0 + d2;
        const du = point[0] - (n1 * a + n2 * 0.5 * a);
        const dv = point[1] - n2 * sqrt3HalfA;
        const distSq = du * du + dv * dv;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          uWs = du;
          vWs = dv;
        }
      }
    }
  } else {
    throw invalid("lattice", `must be 'hexagonal' or 'square', got '${lattice}'`);
  }
  return evalSkyrmion(params, [uWs, vWs, point[2]], 1.0, wallType);
}

function evalSpiral(params: Record<string, unknown>, point: Vec3): Vec3 {
  const spiralKind = stringParam(params, "spiral_kind", "cycloidal");
  const wavelength = positive(params, "wavelength");
  const qHat = normalizeChecked(
    vectorParam(params, "propagation_axis", [1, 0, 0]),
    "propagation_axis",
  );
  const chirality = signParam(params, "chirality", 1);
  const phaseRad = finiteNumber(params, "phase_rad", 0.0);
  let e1: Vec3;
  let e2: Vec3;
  if (spiralKind === "proper_screw") {
    [e1, e2] = orthonormalBasisFromNormal(qHat);
  } else if (spiralKind === "cycloidal") {
    const defaultNormal: Vec3 = Math.abs(qHat[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    const rawN = normalizeChecked(
      vectorParam(params, "spin_plane_normal", defaultNormal),
      "spin_plane_normal",
    );
    const proj = dot(rawN, qHat);
    if (Math.abs(proj) > 1.0 - 1.0e-6) {
      throw invalid(
        "spin_plane_normal",
        "must not be parallel to propagation_axis for a cycloidal spiral",
      );
    }
    const nS = normalizeChecked(sub(rawN, scaleVec(qHat, proj)), "spin_plane_normal");
    e1 = qHat;
    e2 = normalizeChecked(cross(nS, qHat), "spin_plane_normal");
  } else if (spiralKind === "custom_plane") {
    const nS = normalizeChecked(
      vectorParam(params, "spin_plane_normal", [0, 1, 0]),
      "spin_plane_normal",
    );
    [e1, e2] = orthonormalBasisFromNormal(nS);
  } else {
    throw invalid(
      "spiral_kind",
      `must be 'cycloidal', 'proper_screw', or 'custom_plane', got '${spiralKind}'`,
    );
  }
  const phase = chirality * (TAU / wavelength) * dot(qHat, point) + phaseRad;
  return normalizeChecked(add(scaleVec(e1, Math.cos(phase)), scaleVec(e2, Math.sin(phase))), "spiral");
}

/**
 * 3D Bloch point hedgehog per docs/physics/0534 (texture-bloch-point-v2).
 * `core_radius` is validated positive as the physical core-indicator / gizmo
 * marker radius, while the analytic unit-vector field is the exact scale-invariant
 * 3D hedgehog with regular origin limit `polarity * [0, 0, sz]` for `r <= 1e-15 m`
 * (aligned across Rust, Python, and TypeScript).
 */
function evalBlochPoint(params: Record<string, unknown>, point: Vec3): Vec3 {
  const bpKind = stringParam(params, "bp_kind", "circulating");
  if (bpKind !== "radial" && bpKind !== "circulating" && bpKind !== "hyperbolic") {
    throw invalid("bp_kind", `must be 'radial', 'circulating', or 'hyperbolic', got '${bpKind}'`);
  }
  const polarity = signParam(params, "polarity", 1);
  const defaultTwist = bpKind === "circulating" ? FRAC_PI_2 : 0.0;
  const twist = finiteNumber(params, "twist_rad", defaultTwist);
  positive(params, "core_radius", 1.0e-9);
  const r = norm(point);
  const uHat: Vec3 = r <= 1.0e-15 ? [0, 0, 1] : scaleVec(point, 1.0 / r);
  const sz = bpKind === "hyperbolic" ? -1.0 : 1.0;
  const vx = uHat[0];
  const vy = uHat[1];
  const vz = sz * uHat[2];
  const cosT = Math.cos(twist);
  const sinT = Math.sin(twist);
  return [
    polarity * (cosT * vx - sinT * vy),
    polarity * (sinT * vx + cosT * vy),
    polarity * vz,
  ];
}

function modEuclidInt(value: number, modulus: number): number {
  const r = value % modulus;
  return r < 0 ? r + modulus : r;
}

function nearestInt(value: number): number {
  return Math.floor(value + 0.5);
}

function evalArtificialSpinIce(params: Record<string, unknown>, point: Vec3): Vec3 {
  const lattice = stringParam(params, "lattice", "square");
  const vertexState = stringParam(params, "vertex_state", "type_i_ground");
  if (
    vertexState !== "type_i_ground" &&
    vertexState !== "type_ii_polarized" &&
    vertexState !== "monopole_pair"
  ) {
    throw invalid(
      "vertex_state",
      `must be 'type_i_ground', 'type_ii_polarized', or 'monopole_pair', got '${vertexState}'`,
    );
  }
  const a = positive(params, "pitch");
  const u = point[0];
  const v = point[1];
  if (lattice === "square") {
    const hNu = Math.floor(u / a);
    const hNv = nearestInt(v / a);
    const hDu = u - (hNu + 0.5) * a;
    const hDv = v - hNv * a;
    const hDistSq = hDu * hDu + hDv * hDv;

    const vNu = nearestInt(u / a);
    const vNv = Math.floor(v / a);
    const vDu = u - vNu * a;
    const vDv = v - (vNv + 0.5) * a;
    const vDistSq = vDu * vDu + vDv * vDv;

    if (hDistSq <= vDistSq) {
      let signVal =
        vertexState === "type_ii_polarized"
          ? 1.0
          : modEuclidInt(hNu + hNv, 2) === 0
            ? 1.0
            : -1.0;
      if (vertexState === "monopole_pair" && hNu === 0 && hNv === 0) {
        signVal = -signVal;
      }
      return [signVal, 0.0, 0.0];
    }
    const signVal =
      vertexState === "type_ii_polarized"
        ? 1.0
        : modEuclidInt(vNu + vNv, 2) === 0
          ? -1.0
          : 1.0;
    return [0.0, signVal, 0.0];
  }

  if (lattice === "kagome") {
    const b1x = 1.5 * a;
    const b1y = 0.5 * SQRT_3 * a;
    const b2x = 1.5 * a;
    const b2y = -0.5 * SQRT_3 * a;
    const fSum = u / (1.5 * a);
    const fDiff = v / (0.5 * SQRT_3 * a);
    const i0 = Math.round(0.5 * (fSum + fDiff));
    const j0 = Math.round(0.5 * (fSum - fDiff));
    const bonds: readonly Vec3[] = [
      [1.0, 0.0, 0.0],
      [-0.5, 0.5 * SQRT_3, 0.0],
      [-0.5, -0.5 * SQRT_3, 0.0],
    ];
    let bestDistSq = Number.POSITIVE_INFINITY;
    let bestI = i0;
    let bestJ = j0;
    let bestK = 0;
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        const ii = i0 + di;
        const jj = j0 + dj;
        const ax = ii * b1x + jj * b2x;
        const ay = ii * b1y + jj * b2y;
        for (let k = 0; k < 3; k += 1) {
          const bond = bonds[k]!;
          const mx = ax + 0.5 * a * bond[0];
          const my = ay + 0.5 * a * bond[1];
          const du = u - mx;
          const dv = v - my;
          const distSq = du * du + dv * dv;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestI = ii;
            bestJ = jj;
            bestK = k;
          }
        }
      }
    }
    const bond = bonds[bestK]!;
    let signVal =
      vertexState === "type_ii_polarized"
        ? bestK === 0
          ? 1.0
          : -1.0
        : bestK === modEuclidInt(bestI - bestJ, 3)
          ? 1.0
          : -1.0;
    if (vertexState === "monopole_pair" && bestI === 0 && bestJ === 0 && bestK === 0) {
      signVal = -signVal;
    }
    return [signVal * bond[0], signVal * bond[1], 0.0];
  }

  throw invalid("lattice", `must be 'square' or 'kagome', got '${lattice}'`);
}

function localEvaluate(
  presetKind: string,
  params: Record<string, unknown>,
  point: Vec3,
): Vec3 {
  switch (presetKind) {
    case "uniform":
      return normalizeChecked(vectorParam(params, "direction"), "direction");
    case "random":
    case "random_seeded": {
      const seed = params.seed !== undefined ? integer(params, "seed") : 1;
      if (seed < 0) throw invalid("seed", "must be an unsigned integer");
      return randomUnitVector(seed, point);
    }
    case "vortex":
      return evalVortex(params, point, 1.0);
    case "antivortex":
      return evalVortex(params, point, -1.0);
    case "vortex_wall":
      return evalVortexWall(params, point);
    case "bloch_skyrmion":
      return evalSkyrmion(params, point, 1.0, "bloch");
    case "neel_skyrmion":
      return evalSkyrmion(params, point, 1.0, "neel");
    case "antiskyrmion":
      return evalSkyrmion(params, point, -1.0, "neel");
    case "skyrmionium":
      return evalSkyrmionium(params, point);
    case "hopfion":
      return evalHopfion(params, point);
    case "hopfion_compact_support":
      return evalHopfionCompactSupport(params, point);
    case "bimeron":
      return evalBimeron(params, point);
    case "domain_wall":
      return evalDomainWall(params, point);
    case "two_domain":
      return evalTwoDomain(params, point);
    case "helical":
      return evalHelical(params, point);
    case "conical":
      return evalConical(params, point);
    case "skyrmion_lattice":
      return evalSkyrmionLattice(params, point);
    case "spiral":
      return evalSpiral(params, point);
    case "bloch_point":
      return evalBlochPoint(params, point);
    case "artificial_spin_ice":
      return evalArtificialSpinIce(params, point);
    default:
      throw invalid("preset_kind", `unsupported preset '${presetKind}'`);
  }
}

type ClampOutcome =
  | { kind: "sample"; point: Vec3 }
  | { kind: "background"; vector: Vec3 };

function validateAxisExtentV2(mapping: TextureMappingSpecV2 | undefined): number | null {
  const rawMode = (mapping?.axis_extent_mode ?? "").trim();
  if (!rawMode || rawMode.toLowerCase() === "uniform") {
    return null;
  }
  if (rawMode.toLowerCase() === "thickness") {
    const thickness = mapping?.axis_thickness_m;
    if (typeof thickness !== "number" || !Number.isFinite(thickness) || thickness <= EPSILON) {
      throw invalid(
        "mapping.axis_thickness_m",
        "positive axis_thickness_m is required when axis_extent_mode == 'thickness'",
      );
    }
    return 0.5 * thickness;
  }
  throw invalid("mapping.axis_extent_mode", `unsupported axis_extent_mode '${rawMode}'`);
}

function resolveSlabBackgroundV2(
  presetKind: string,
  params: Record<string, unknown>,
  frame: OrientedPlaneFrame | null,
  mapping: TextureMappingSpecV2 | undefined,
): Vec3 {
  if (mapping?.background_vector) {
    return normalizeChecked(mapping.background_vector, "mapping.background_vector");
  }
  let localBg: Vec3;
  switch (presetKind) {
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
    case "skyrmion_lattice": {
      const polarity = signParam(params, "core_polarity", 1);
      localBg = [0, 0, -polarity];
      break;
    }
    case "skyrmionium":
    case "hopfion": {
      const bgSign = signParam(params, "background_sign", 1);
      localBg = [0, 0, bgSign];
      break;
    }
    case "bimeron": {
      const bgSign = signParam(params, "background_sign", 1);
      localBg = [bgSign, 0, 0];
      break;
    }
    case "hopfion_compact_support":
      localBg = [0, 0, 1];
      break;
    default:
      localBg = [0, 0, 1];
      break;
  }
  if (frame !== null && METRIC_PRESETS.has(presetKind)) {
    return frameVectorToWorld(localBg, frame);
  }
  return localBg;
}

/**
 * Canonical default tile_period formula shared identically across Rust, Python, and TS.
 *
 * 1. Explicit `tile_period` wins when provided.
 * 2. Explicit `targetBoundsExtent` (domain/region AABB extents before `texture_transform`)
 *    is used when finite and positive on all 3 axes.
 * 3. Otherwise compute the AABB extent over active source-space points before
 *    `texture_transform`, replacing any degenerate axis (<= EPSILON) with the maximum
 *    positive axis extent (failing closed with null when all axes are degenerate).
 */
export function resolveDefaultTilePeriod(
  explicitTilePeriod: readonly [number, number, number] | null | undefined,
  targetBoundsExtent: readonly [number, number, number] | null | undefined,
  activeSourcePoints: readonly Vec3[],
): Vec3 | null {
  if (explicitTilePeriod) {
    return [explicitTilePeriod[0], explicitTilePeriod[1], explicitTilePeriod[2]];
  }
  if (
    targetBoundsExtent &&
    Number.isFinite(targetBoundsExtent[0]) &&
    Number.isFinite(targetBoundsExtent[1]) &&
    Number.isFinite(targetBoundsExtent[2]) &&
    targetBoundsExtent[0] > EPSILON &&
    targetBoundsExtent[1] > EPSILON &&
    targetBoundsExtent[2] > EPSILON
  ) {
    return [targetBoundsExtent[0], targetBoundsExtent[1], targetBoundsExtent[2]];
  }
  if (activeSourcePoints.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let anyFinite = false;
  for (let i = 0; i < activeSourcePoints.length; i += 1) {
    const pt = activeSourcePoints[i]!;
    if (Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Number.isFinite(pt[2])) {
      anyFinite = true;
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
      if (pt[2] < minZ) minZ = pt[2];
      if (pt[2] > maxZ) maxZ = pt[2];
    }
  }
  if (!anyFinite) {
    return null;
  }
  const rawX = maxX - minX;
  const rawY = maxY - minY;
  const rawZ = maxZ - minZ;
  const maxExt = Math.max(rawX, rawY, rawZ);
  if (!Number.isFinite(maxExt) || maxExt <= EPSILON) {
    return null;
  }
  return [
    rawX > EPSILON ? rawX : maxExt,
    rawY > EPSILON ? rawY : maxExt,
    rawZ > EPSILON ? rawZ : maxExt,
  ];
}

function applyClampModeV2(
  transformed: Vec3,
  pivot: Vec3,
  mapping: TextureMappingSpecV2 | undefined,
  fallbackExtent: readonly [number, number, number] | null | undefined,
  frame: OrientedPlaneFrame | null,
  isMetric: boolean,
): ClampOutcome {
  const mode = (mapping?.clamp_mode ?? "none").trim();
  if (!mode || mode === "none") {
    return { kind: "sample", point: transformed };
  }
  const period = mapping?.tile_period ?? fallbackExtent ?? null;
  if (!period) {
    throw invalid(
      "mapping.tile_period",
      "positive metric box/period [Px, Py, Pz] is required when clamp_mode != 'none'",
    );
  }
  if (period.some((p) => !Number.isFinite(p) || p <= EPSILON)) {
    throw invalid("mapping.tile_period", "all period components must be finite and positive");
  }
  const rel = sub(transformed, pivot);
  switch (mode) {
    case "clamp":
      return {
        kind: "sample",
        point: [
          Math.max(-0.5 * period[0], Math.min(0.5 * period[0], rel[0])) + pivot[0],
          Math.max(-0.5 * period[1], Math.min(0.5 * period[1], rel[1])) + pivot[1],
          Math.max(-0.5 * period[2], Math.min(0.5 * period[2], rel[2])) + pivot[2],
        ],
      };
    case "repeat":
      return {
        kind: "sample",
        point: [
          wrapMetricRepeat(rel[0], period[0]) + pivot[0],
          wrapMetricRepeat(rel[1], period[1]) + pivot[1],
          wrapMetricRepeat(rel[2], period[2]) + pivot[2],
        ],
      };
    case "mirror":
      return {
        kind: "sample",
        point: [
          wrapMetricMirror(rel[0], period[0]) + pivot[0],
          wrapMetricMirror(rel[1], period[1]) + pivot[1],
          wrapMetricMirror(rel[2], period[2]) + pivot[2],
        ],
      };
    case "background": {
      const outside =
        Math.abs(rel[0]) > 0.5 * period[0] ||
        Math.abs(rel[1]) > 0.5 * period[1] ||
        Math.abs(rel[2]) > 0.5 * period[2];
      if (outside) {
        if (mapping?.background_vector) {
          return {
            kind: "background",
            vector: normalizeChecked(mapping.background_vector, "mapping.background_vector"),
          };
        }
        const defaultLocal: Vec3 = [0, 0, 1];
        return {
          kind: "background",
          vector: isMetric && frame !== null ? frameVectorToWorld(defaultLocal, frame) : defaultLocal,
        };
      }
      return { kind: "sample", point: transformed };
    }
    default:
      throw invalid("mapping.clamp_mode", `unsupported clamp_mode '${mode}'`);
  }
}

function sourcePositionForCoordinate(
  coord: Vec3 | TextureSampleCoordinate,
  mapping?: TextureMappingSpecV2,
  targetBounds?: TargetMetricBounds | null,
): Vec3 {
  const space = (mapping?.space ?? "object").toLowerCase();
  if (Array.isArray(coord)) {
    const pt = coord as Vec3;
    if (space === "region" && targetBounds) {
      return sub(pt, targetBounds.localCenter);
    }
    return pt;
  }
  if (space === "region") {
    if (coord.positionRegion) return coord.positionRegion;
    if (targetBounds) return sub(coord.positionObject, targetBounds.localCenter);
    return coord.positionObject;
  }
  if (space === "world") {
    return coord.positionWorld ?? coord.positionObject;
  }
  return coord.positionObject;
}

/**
 * Evaluates a single sample point [m] through the complete v2 pipeline:
 * `source_position -> PreparedTextureTransform -> applyClampModeV2 -> frame -> localEvaluate -> vectorToSource`.
 */
export function samplePresetTextureV2Client(
  spec: PresetTextureSpecV2,
  pointMeters: Vec3 | TextureSampleCoordinate,
  targetBounds?: TargetMetricBounds | null,
): Vec3 {
  const params = spec.preset_params ?? {};
  const frame = resolveFrame(params, spec.mapping?.projection);
  if (THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(spec.preset_kind) && frame !== null) {
    throw invalid(
      "mapping.projection",
      "the selected three-dimensional preset requires object_local projection",
    );
  }
  const prepared = prepareTransform(spec.texture_transform);
  const halfAxisThickness = validateAxisExtentV2(spec.mapping);
  const isMetric = METRIC_PRESETS.has(spec.preset_kind);
  const src = sourcePositionForCoordinate(pointMeters, spec.mapping, targetBounds);
  const transformed = pointToTexture(prepared, src);
  if (halfAxisThickness !== null) {
    const rel = sub(transformed, prepared.pivot);
    const zNormal = isMetric && frame !== null ? dot(rel, frame.e_n) : rel[2];
    if (Math.abs(zNormal) > halfAxisThickness * (1.0 + 1.0e-12)) {
      const slabBg = resolveSlabBackgroundV2(spec.preset_kind, params, frame, spec.mapping);
      return vectorToSource(prepared, slabBg);
    }
  }
  const fallbackExtent = resolveDefaultTilePeriod(
    spec.mapping?.tile_period,
    targetBounds?.size ?? null,
    [],
  );
  const outcome = applyClampModeV2(
    transformed,
    prepared.pivot,
    spec.mapping,
    fallbackExtent,
    frame,
    isMetric,
  );
  if (outcome.kind === "background") {
    return vectorToSource(prepared, outcome.vector);
  }
  const localPt = isMetric && frame !== null ? frameCoordinates(outcome.point, frame) : outcome.point;
  const localVec = localEvaluate(spec.preset_kind, params, localPt);
  const srcVec = isMetric && frame !== null ? frameVectorToWorld(localVec, frame) : localVec;
  return vectorToSource(prepared, srcVec);
}

/**
 * Batch evaluator optimized for 2D `<TexturePreviewCanvas>` (4,608 samples)
 * and 3D HSL vertex coloring: validates parameters and prepares transform once.
 */
export function samplePresetTextureV2Batch(
  spec: PresetTextureSpecV2,
  points: readonly (Vec3 | TextureSampleCoordinate)[],
  targetBounds?: TargetMetricBounds | null,
): Vec3[] {
  const params = spec.preset_params ?? {};
  const frame = resolveFrame(params, spec.mapping?.projection);
  if (THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(spec.preset_kind) && frame !== null) {
    throw invalid(
      "mapping.projection",
      "the selected three-dimensional preset requires object_local projection",
    );
  }
  const prepared = prepareTransform(spec.texture_transform);
  localEvaluate(spec.preset_kind, params, [0, 0, 0]);
  const halfAxisThickness = validateAxisExtentV2(spec.mapping);
  const slabBg =
    halfAxisThickness !== null
      ? resolveSlabBackgroundV2(spec.preset_kind, params, frame, spec.mapping)
      : null;
  const isMetric = METRIC_PRESETS.has(spec.preset_kind);

  const sourcePositions: Vec3[] = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    sourcePositions[i] = sourcePositionForCoordinate(points[i]!, spec.mapping, targetBounds);
  }
  const clampMode = (spec.mapping?.clamp_mode ?? "none").trim();
  const fallbackExtent =
    clampMode && clampMode !== "none"
      ? resolveDefaultTilePeriod(
          spec.mapping?.tile_period,
          targetBounds?.size ?? null,
          sourcePositions,
        )
      : null;

  const out: Vec3[] = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const src = sourcePositions[i]!;
    const transformed = pointToTexture(prepared, src);
    if (halfAxisThickness !== null && slabBg !== null) {
      const rel = sub(transformed, prepared.pivot);
      const zNormal = isMetric && frame !== null ? dot(rel, frame.e_n) : rel[2];
      if (Math.abs(zNormal) > halfAxisThickness * (1.0 + 1.0e-12)) {
        out[i] = vectorToSource(prepared, slabBg);
        continue;
      }
    }
    const outcome = applyClampModeV2(
      transformed,
      prepared.pivot,
      spec.mapping,
      fallbackExtent,
      frame,
      isMetric,
    );
    if (outcome.kind === "background") {
      out[i] = vectorToSource(prepared, outcome.vector);
      continue;
    }
    const localPt = isMetric && frame !== null ? frameCoordinates(outcome.point, frame) : outcome.point;
    const localVec = localEvaluate(spec.preset_kind, params, localPt);
    const srcVec = isMetric && frame !== null ? frameVectorToWorld(localVec, frame) : localVec;
    out[i] = vectorToSource(prepared, srcVec);
  }
  return out;
}

/**
 * Direct mirror of Python `preset_eval_v2.py::evaluate_preset_texture_v2` for
 * pre-transformed texture coordinates (used by `magnetization_textures_v2_parity.json`).
 */
export function evaluatePresetTextureV2Points(
  presetKind: string,
  params: Record<string, unknown>,
  points: readonly Vec3[],
  options?: {
    projection?: TextureProjectionModeV2 | string | null;
    rotationQuat?: readonly [number, number, number, number] | null;
    rotateVectors?: boolean;
    clampMode?: TextureClampModeV2 | string;
    tilePeriod?: readonly [number, number, number] | null;
    backgroundVector?: readonly [number, number, number] | null;
    axisExtentMode?: TextureAxisExtentModeV2 | string | null;
    axisThicknessM?: number | null;
    pivot?: readonly [number, number, number];
    targetBoundsExtent?: readonly [number, number, number] | null;
  },
): Vec3[] {
  const frame = resolveFrame(params, options?.projection);
  if (THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(presetKind) && frame !== null) {
    throw invalid(
      "mapping.projection",
      "the selected three-dimensional preset requires object_local projection",
    );
  }
  const rotateVectors = options?.rotateVectors !== false;
  const quat =
    options?.rotationQuat && rotateVectors
      ? normalizeQuaternion(options.rotationQuat)
      : null;
  const pivot: Vec3 = options?.pivot
    ? [options.pivot[0], options.pivot[1], options.pivot[2]]
    : [0, 0, 0];
  const mapping: TextureMappingSpecV2 = {
    clamp_mode: options?.clampMode ?? "none",
    tile_period: options?.tilePeriod ?? null,
    background_vector: options?.backgroundVector ?? null,
    axis_extent_mode: options?.axisExtentMode ?? null,
    axis_thickness_m: options?.axisThicknessM ?? null,
  };
  localEvaluate(presetKind, params, [0, 0, 0]);
  const halfAxisThickness = validateAxisExtentV2(mapping);
  const slabBg =
    halfAxisThickness !== null
      ? resolveSlabBackgroundV2(presetKind, params, frame, mapping)
      : null;
  const isMetric = METRIC_PRESETS.has(presetKind);
  const clampMode = (mapping.clamp_mode ?? "none").trim();
  const fallbackExtent =
    clampMode && clampMode !== "none"
      ? resolveDefaultTilePeriod(
          mapping.tile_period,
          options?.targetBoundsExtent ?? null,
          points,
        )
      : null;
  const out: Vec3[] = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i]!;
    if (halfAxisThickness !== null && slabBg !== null) {
      const rel = sub(pt, pivot);
      const zNormal = isMetric && frame !== null ? dot(rel, frame.e_n) : rel[2];
      if (Math.abs(zNormal) > halfAxisThickness * (1.0 + 1.0e-12)) {
        out[i] = quat ? rotateVectorByQuaternion(slabBg, quat) : slabBg;
        continue;
      }
    }
    const outcome = applyClampModeV2(pt, pivot, mapping, fallbackExtent, frame, isMetric);
    if (outcome.kind === "background") {
      out[i] = quat ? rotateVectorByQuaternion(outcome.vector, quat) : outcome.vector;
      continue;
    }
    const localPt = isMetric && frame !== null ? frameCoordinates(outcome.point, frame) : outcome.point;
    const localVec = localEvaluate(presetKind, params, localPt);
    const worldVec = isMetric && frame !== null ? frameVectorToWorld(localVec, frame) : localVec;
    out[i] = quat ? rotateVectorByQuaternion(worldVec, quat) : worldVec;
  }
  return out;
}

/**
 * Canonical Mumax3 / OOMMF / Ubermag HSL color wheel encoding (Volume II §4.2):
 * - in-plane angle arg(m_u + i m_v) -> Hue [0, 360)
 * - out-of-plane component m_n in [-1, +1] -> Saturation = 0.88 * sqrt(1 - m_n^2), Lightness = 0.50 + 0.44 * m_n.
 */
export function spinVectorToHsl(
  mu: number,
  mv: number,
  mn: number,
): { h: number; s: number; l: number } {
  const clampedMn = Math.max(-1.0, Math.min(1.0, Number.isFinite(mn) ? mn : 0));
  const mPerp = Math.sqrt(Math.max(0.0, 1.0 - clampedMn * clampedMn));
  const rawAngleDeg = (Math.atan2(mv, mu) * 180.0) / Math.PI;
  const h = ((Number.isFinite(rawAngleDeg) ? rawAngleDeg : 0) + 360.0) % 360.0;
  const s = 0.88 * mPerp;
  const l = 0.5 + 0.44 * clampedMn;
  return { h, s, l };
}

export function spinVectorToRgbUnit(mu: number, mv: number, mn: number): Vec3 {
  const { h, s, l } = spinVectorToHsl(mu, mv, mn);
  if (s <= 1e-6) {
    return [l, l, l];
  }
  const c = (1.0 - Math.abs(2.0 * l - 1.0)) * s;
  const hPrime = h / 60.0;
  const x = c * (1.0 - Math.abs((hPrime % 2.0) - 1.0));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hPrime < 1) {
    r1 = c;
    g1 = x;
  } else if (hPrime < 2) {
    r1 = x;
    g1 = c;
  } else if (hPrime < 3) {
    g1 = c;
    b1 = x;
  } else if (hPrime < 4) {
    g1 = x;
    b1 = c;
  } else if (hPrime < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = l - 0.5 * c;
  return [
    Math.max(0, Math.min(1, r1 + m)),
    Math.max(0, Math.min(1, g1 + m)),
    Math.max(0, Math.min(1, b1 + m)),
  ];
}

export function spinVectorToHslCss(mu: number, mv: number, mn: number): string {
  const { h, s, l } = spinVectorToHsl(mu, mv, mn);
  return `hsl(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}
