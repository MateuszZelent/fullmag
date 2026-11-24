/**
 * Canonical Array3D lattice specification, index formulas, Bravais presets,
 * bounds derivation, and budget limits (1:1 shared contract with Rust & Python).
 */

export const MAX_ARRAY_AXIS_COUNT = 10_000;
export const MAX_EXPANDED_SCENE_OBJECTS = 256;
export const MAX_ARRAY_INSTANCES_FEM_OCC = 2_500;
export const MAX_ARRAY_INSTANCES_FDM = 100_000;
export const MAX_ARRAY_FDM_CANDIDATES_PER_QUERY = 256;

export type ArrayAxisName = "x" | "y" | "z";
export type ArrayDirection = "positive" | "negative" | "symmetric";
export type ArraySpacingMode = "lattice_step" | "bounding_box_gap";
export type ArrayRealizationMode = "modifier_in_object" | "expand_to_objects";
export type Array3DPresetId =
  | "rectangular_xy"
  | "hexagonal_xy"
  | "multilayer_z"
  | "stripe_1d";

export type Vec3Tuple = [number, number, number];

export interface ArrayAxisSpec {
  axis: ArrayAxisName;
  enabled: boolean;
  count: number;
  direction: ArrayDirection;
  spacing_mode: ArraySpacingMode;
  pitch_m: number;
  relative_factor: number;
  gap_m: number;
  step_translation_extra_m: Vec3Tuple;
  step_rotation_euler_deg: Vec3Tuple;
  step_scale_factor: Vec3Tuple;
}

export type Array3DAxes = [ArrayAxisSpec, ArrayAxisSpec, ArrayAxisSpec];

export interface ParsedArray3DGeometry {
  axes: Array3DAxes;
  child: Record<string, unknown>;
  childTransform?: Record<string, unknown>;
  mergeOverlapping: boolean;
}

export interface Array3DInstanceTransform {
  index: number;
  kx: number;
  ky: number;
  kz: number;
  rotationEulerDeg: Vec3Tuple;
  scale: Vec3Tuple;
  translation: Vec3Tuple;
}

export interface Array3DBudgetStatus {
  canExpandToObjects: boolean;
  exceedsFdmLimit: boolean;
  exceedsFemOccLimit: boolean;
  level: "ok" | "warn" | "error";
  message: string;
  totalInstances: number;
}

export interface Array3DWorldBounds {
  max: Vec3Tuple;
  min: Vec3Tuple;
  size: Vec3Tuple;
}

const AXIS_INDEX: Record<ArrayAxisName, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vec3Or(value: unknown, fallback: Vec3Tuple): Vec3Tuple {
  if (Array.isArray(value) && value.length >= 3) {
    return [
      finiteOr(value[0], fallback[0]),
      finiteOr(value[1], fallback[1]),
      finiteOr(value[2], fallback[2]),
    ];
  }
  return [...fallback];
}

export function normalizeArrayDirection(raw: unknown): ArrayDirection {
  if (raw === "negative" || raw === "-") return "negative";
  if (raw === "symmetric" || raw === "+-" || raw === "±") return "symmetric";
  return "positive";
}

export function defaultArrayAxisSpec(
  axis: ArrayAxisName,
  overrides: Partial<ArrayAxisSpec> = {},
): ArrayAxisSpec {
  return {
    axis,
    count: axis === "z" ? 1 : 3,
    direction: "positive",
    enabled: axis !== "z",
    gap_m: 0,
    pitch_m: 100e-9,
    relative_factor: 1,
    spacing_mode: "lattice_step",
    step_rotation_euler_deg: [0, 0, 0],
    step_scale_factor: [1, 1, 1],
    step_translation_extra_m: [0, 0, 0],
    ...overrides,
  };
}

export function defaultArray3DAxes(): Array3DAxes {
  return [
    defaultArrayAxisSpec("x"),
    defaultArrayAxisSpec("y"),
    defaultArrayAxisSpec("z"),
  ];
}

export function normalizeArrayAxisSpec(
  raw: unknown,
  fallbackAxis: ArrayAxisName,
): ArrayAxisSpec {
  const rec = asRecord(raw);
  if (!rec) return defaultArrayAxisSpec(fallbackAxis, { count: 1, enabled: false });
  const rawCount = Math.round(finiteOr(rec.count, 1));
  const count = Math.max(1, Math.min(MAX_ARRAY_AXIS_COUNT, rawCount));
  const axis: ArrayAxisName =
    rec.axis === "x" || rec.axis === "y" || rec.axis === "z"
      ? rec.axis
      : fallbackAxis;
  const spacingMode: ArraySpacingMode =
    rec.spacing_mode === "bounding_box_gap" ? "bounding_box_gap" : "lattice_step";
  return {
    axis,
    count,
    direction: normalizeArrayDirection(rec.direction),
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : count > 1,
    gap_m: finiteOr(rec.gap_m, 0),
    pitch_m: finiteOr(rec.pitch_m, 100e-9),
    relative_factor: finiteOr(rec.relative_factor, 1),
    spacing_mode: spacingMode,
    step_rotation_euler_deg: vec3Or(rec.step_rotation_euler_deg, [0, 0, 0]),
    step_scale_factor: vec3Or(rec.step_scale_factor, [1, 1, 1]),
    step_translation_extra_m: vec3Or(rec.step_translation_extra_m, [0, 0, 0]),
  };
}

export function parseArray3DGeometry(geometry: unknown): ParsedArray3DGeometry | null {
  const rec = asRecord(geometry);
  if (!rec) return null;
  const kind = String(rec.geometry_kind ?? rec.kind ?? "").trim().toLowerCase();
  if (kind !== "array3d" && kind !== "array_3d") return null;
  const params = asRecord(rec.geometry_params) ?? asRecord(rec.params);
  if (!params) return null;
  const child = asRecord(params.child);
  if (!child) return null;
  const rawAxes = Array.isArray(params.axes) ? params.axes : [];
  const axes: Array3DAxes = [
    normalizeArrayAxisSpec(rawAxes[0], "x"),
    normalizeArrayAxisSpec(rawAxes[1], "y"),
    normalizeArrayAxisSpec(rawAxes[2], "z"),
  ];
  const childTransform = asRecord(params.child_transform) ?? undefined;
  return {
    axes,
    child,
    ...(childTransform ? { childTransform } : {}),
    mergeOverlapping: Boolean(params.merge_overlapping),
  };
}

export function array3DDimensionsLabel(axes: readonly ArrayAxisSpec[]): string {
  const counts = axes.map((spec) => (spec.enabled ? Math.max(1, Math.round(spec.count)) : 1));
  return `${counts[0] ?? 1}×${counts[1] ?? 1}×${counts[2] ?? 1}`;
}

/**
 * Canonical k_a sequence matching Rust & Python 1:1:
 * - disabled or count <= 1 -> [0]
 * - "positive" -> [0, 1, ..., N - 1]
 * - "negative" -> [0, -1, ..., -(N - 1)]
 * - "symmetric" -> [i - (N - 1) / 2 for i in 0..N]
 */
export function canonicalAxisIndices(spec: Pick<ArrayAxisSpec, "enabled" | "count" | "direction">): number[] {
  if (!spec.enabled) return [0];
  const n = Math.max(1, Math.min(MAX_ARRAY_AXIS_COUNT, Math.round(spec.count)));
  if (n <= 1) return [0];
  const indices: number[] = [];
  if (spec.direction === "negative") {
    for (let i = 0; i < n; i += 1) {
      indices.push(i === 0 ? 0 : -i);
    }
    return indices;
  }
  if (spec.direction === "symmetric") {
    const center = (n - 1) / 2;
    for (let i = 0; i < n; i += 1) {
      const value = i - center;
      indices.push(Object.is(value, -0) ? 0 : value);
    }
    return indices;
  }
  for (let i = 0; i < n; i += 1) {
    indices.push(i);
  }
  return indices;
}

export function axisStepDeltaM(
  spec: Pick<ArrayAxisSpec, "axis" | "spacing_mode" | "pitch_m" | "relative_factor" | "gap_m">,
  childSize: readonly [number, number, number],
): number {
  if (spec.spacing_mode === "bounding_box_gap") {
    const extent = childSize[AXIS_INDEX[spec.axis]] ?? 0;
    return spec.relative_factor * extent + spec.gap_m;
  }
  return spec.pitch_m;
}

export function axisStepVectorM(
  spec: ArrayAxisSpec,
  childSize: readonly [number, number, number],
): Vec3Tuple {
  const delta = axisStepDeltaM(spec, childSize);
  const idx = AXIS_INDEX[spec.axis];
  const vec: Vec3Tuple = [
    spec.step_translation_extra_m[0],
    spec.step_translation_extra_m[1],
    spec.step_translation_extra_m[2],
  ];
  vec[idx] += delta;
  return vec;
}

export function axisSpanM(
  spec: ArrayAxisSpec,
  childSize: readonly [number, number, number],
): number {
  if (!spec.enabled || spec.count <= 1) return 0;
  const delta = axisStepDeltaM(spec, childSize);
  return Math.abs(delta) * (Math.round(spec.count) - 1);
}

export function computeArray3DInstanceCount(axes: readonly ArrayAxisSpec[]): number {
  let total = 1;
  for (const axis of axes) {
    const n = axis.enabled ? Math.max(1, Math.round(axis.count)) : 1;
    total *= n;
    if (!Number.isFinite(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

export function computeArray3DBudgetStatus(
  totalInstances: number,
  realization: ArrayRealizationMode,
): Array3DBudgetStatus {
  const canExpandToObjects = totalInstances <= MAX_EXPANDED_SCENE_OBJECTS;
  const exceedsFemOccLimit = totalInstances > MAX_ARRAY_INSTANCES_FEM_OCC;
  const exceedsFdmLimit = totalInstances > MAX_ARRAY_INSTANCES_FDM;

  if (exceedsFdmLimit) {
    return {
      canExpandToObjects,
      exceedsFdmLimit,
      exceedsFemOccLimit,
      level: "error",
      message: `Instance count (${totalInstances.toLocaleString()}) exceeds FDM hard budget (${MAX_ARRAY_INSTANCES_FDM.toLocaleString()}).`,
      totalInstances,
    };
  }
  if (realization === "expand_to_objects" && !canExpandToObjects) {
    return {
      canExpandToObjects,
      exceedsFdmLimit,
      exceedsFemOccLimit,
      level: "error",
      message: `Expand-to-objects is blocked above ${MAX_EXPANDED_SCENE_OBJECTS} instances; use Modifier-in-Object instead.`,
      totalInstances,
    };
  }
  if (exceedsFemOccLimit) {
    return {
      canExpandToObjects,
      exceedsFdmLimit,
      exceedsFemOccLimit,
      level: "warn",
      message: `Above FEM/OCC limit (${MAX_ARRAY_INSTANCES_FEM_OCC.toLocaleString()} instances); valid for FDM voxelization up to ${MAX_ARRAY_INSTANCES_FDM.toLocaleString()}.`,
      totalInstances,
    };
  }
  return {
    canExpandToObjects,
    exceedsFdmLimit,
    exceedsFemOccLimit,
    level: "ok",
    message: `${totalInstances.toLocaleString()} instances within FEM/OCC (${MAX_ARRAY_INSTANCES_FEM_OCC.toLocaleString()}) and FDM (${MAX_ARRAY_INSTANCES_FDM.toLocaleString()}) budgets.`,
    totalInstances,
  };
}

export function computeArray3DWorldBounds(
  axes: Array3DAxes,
  childBounds: { min: readonly [number, number, number]; max: readonly [number, number, number] },
): Array3DWorldBounds {
  const childSize: Vec3Tuple = [
    Math.max(0, childBounds.max[0] - childBounds.min[0]),
    Math.max(0, childBounds.max[1] - childBounds.min[1]),
    Math.max(0, childBounds.max[2] - childBounds.min[2]),
  ];
  const vx = axisStepVectorM(axes[0], childSize);
  const vy = axisStepVectorM(axes[1], childSize);
  const vz = axisStepVectorM(axes[2], childSize);
  const kxList = canonicalAxisIndices(axes[0]);
  const kyList = canonicalAxisIndices(axes[1]);
  const kzList = canonicalAxisIndices(axes[2]);
  const kExtrema = (values: readonly number[]) =>
    values.length <= 2 ? values : [Math.min(...values), Math.max(...values)];

  const min: Vec3Tuple = [Infinity, Infinity, Infinity];
  const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  for (const kx of kExtrema(kxList)) {
    for (const ky of kExtrema(kyList)) {
      for (const kz of kExtrema(kzList)) {
        for (let c = 0; c < 3; c += 1) {
          const offset = kx * vx[c]! + ky * vy[c]! + kz * vz[c]!;
          min[c] = Math.min(min[c]!, childBounds.min[c]! + offset);
          max[c] = Math.max(max[c]!, childBounds.max[c]! + offset);
        }
      }
    }
  }
  return {
    max,
    min,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

export function computeArray3DInstanceTransforms(
  axes: Array3DAxes,
  childSize: readonly [number, number, number],
  maxInstances = MAX_ARRAY_INSTANCES_FEM_OCC,
): Array3DInstanceTransform[] {
  const vx = axisStepVectorM(axes[0], childSize);
  const vy = axisStepVectorM(axes[1], childSize);
  const vz = axisStepVectorM(axes[2], childSize);
  const kxList = canonicalAxisIndices(axes[0]);
  const kyList = canonicalAxisIndices(axes[1]);
  const kzList = canonicalAxisIndices(axes[2]);
  const out: Array3DInstanceTransform[] = [];
  let index = 0;

  for (const kx of kxList) {
    for (const ky of kyList) {
      for (const kz of kzList) {
        if (out.length >= maxInstances) return out;
        const translation: Vec3Tuple = [
          kx * vx[0] + ky * vy[0] + kz * vz[0],
          kx * vx[1] + ky * vy[1] + kz * vz[1],
          kx * vx[2] + ky * vy[2] + kz * vz[2],
        ];
        const rotationEulerDeg: Vec3Tuple = [
          kx * axes[0].step_rotation_euler_deg[0] +
            ky * axes[1].step_rotation_euler_deg[0] +
            kz * axes[2].step_rotation_euler_deg[0],
          kx * axes[0].step_rotation_euler_deg[1] +
            ky * axes[1].step_rotation_euler_deg[1] +
            kz * axes[2].step_rotation_euler_deg[1],
          kx * axes[0].step_rotation_euler_deg[2] +
            ky * axes[1].step_rotation_euler_deg[2] +
            kz * axes[2].step_rotation_euler_deg[2],
        ];
        const scale: Vec3Tuple = [
          Math.pow(axes[0].step_scale_factor[0], kx) *
            Math.pow(axes[1].step_scale_factor[0], ky) *
            Math.pow(axes[2].step_scale_factor[0], kz),
          Math.pow(axes[0].step_scale_factor[1], kx) *
            Math.pow(axes[1].step_scale_factor[1], ky) *
            Math.pow(axes[2].step_scale_factor[1], kz),
          Math.pow(axes[0].step_scale_factor[2], kx) *
            Math.pow(axes[1].step_scale_factor[2], ky) *
            Math.pow(axes[2].step_scale_factor[2], kz),
        ];
        out.push({
          index,
          kx,
          ky,
          kz,
          rotationEulerDeg,
          scale,
          translation,
        });
        index += 1;
      }
    }
  }
  return out;
}

export function applyArray3DPreset(
  preset: Array3DPresetId,
  basePitchM = 100e-9,
): Array3DAxes {
  const p = Number.isFinite(basePitchM) && basePitchM > 0 ? basePitchM : 100e-9;
  switch (preset) {
    case "hexagonal_xy":
      return [
        defaultArrayAxisSpec("x", {
          count: 4,
          direction: "symmetric",
          enabled: true,
          pitch_m: p,
        }),
        defaultArrayAxisSpec("y", {
          count: 4,
          direction: "symmetric",
          enabled: true,
          pitch_m: (p * Math.sqrt(3)) / 2,
          step_translation_extra_m: [p / 2, 0, 0],
        }),
        defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: p }),
      ];
    case "multilayer_z":
      return [
        defaultArrayAxisSpec("x", { count: 1, enabled: false, pitch_m: p }),
        defaultArrayAxisSpec("y", { count: 1, enabled: false, pitch_m: p }),
        defaultArrayAxisSpec("z", {
          count: 4,
          direction: "positive",
          enabled: true,
          pitch_m: Math.max(p * 0.2, 10e-9),
        }),
      ];
    case "stripe_1d":
      return [
        defaultArrayAxisSpec("x", {
          count: 6,
          direction: "symmetric",
          enabled: true,
          pitch_m: p,
        }),
        defaultArrayAxisSpec("y", { count: 1, enabled: false, pitch_m: p }),
        defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: p }),
      ];
    case "rectangular_xy":
    default:
      return [
        defaultArrayAxisSpec("x", {
          count: 4,
          direction: "symmetric",
          enabled: true,
          pitch_m: p,
        }),
        defaultArrayAxisSpec("y", {
          count: 4,
          direction: "symmetric",
          enabled: true,
          pitch_m: p,
        }),
        defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: p }),
      ];
  }
}
