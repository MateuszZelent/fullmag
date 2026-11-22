import type {
  PlanarCropState,
  PlanarFieldMetaResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  planarSectionAxes,
  type PlanarSectionAxis,
  type PlanarSectionPlane,
} from "@/kernel/visualization/planarSectionModel";
import {
  pointInsideRegionShape,
  resolveTargetBoundsMeters,
  type TargetMetricBounds,
  type Vec3,
} from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  samplePresetTextureV2Client,
  type PresetTextureSpecV2,
} from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  buildPresetSpecFromDraft,
  hydrateMagneticTextureDraftFromInitializer,
} from "@/shared/domain/magnetization-texture/presetDefaults";

import type { FieldMapViewScope } from "./fieldMapDataPlan";
import { projectPlanarVectors, type PlanarFrame } from "./fieldMapRenderModel";
import {
  derivePlanarComponentScalar,
  isClientDerivablePlanarComponent,
} from "./planarComponentDerivation";
import { PLANAR_OCCUPANCY } from "./planarOccupancy";

type UnknownRecord = Record<string, unknown>;

const MIN_GRID_SIDE = 24;
const MAX_GRID_SIDE = 128;
const MIN_EXTENT_M = 1e-12;

const AXIS_INDEX: Record<PlanarSectionAxis, 0 | 1 | 2> = {
  x: 0,
  y: 1,
  z: 2,
};

const AXIS_UNIT_VECTOR: Record<PlanarSectionAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

export interface AuthoredPlanarSampleInput {
  readonly scene: SceneResource | null | undefined;
  readonly plane: PlanarSectionPlane;
  readonly positionFraction: number;
  readonly resolution?: readonly [number, number] | null;
  readonly crop?: PlanarCropState | null;
  readonly viewScope?: FieldMapViewScope | null;
  readonly component?: string | null;
}

export interface AuthoredPlanarSample {
  readonly frame: PlanarFrame;
  readonly mask: Uint8Array;
  readonly meshOverlay: null;
  readonly meta: PlanarFieldMetaResource;
  readonly sampleIdentity: string;
  readonly scalar: Float64Array;
  readonly vectors: Float64Array;
  readonly worldVectors: Float32Array;
}

interface CompiledRegionLayer {
  readonly regionId: string;
  readonly priority: number;
  readonly regionRecord: UnknownRecord;
  readonly spec: PresetTextureSpecV2;
  readonly regionBounds: TargetMetricBounds;
}

interface CompiledAuthoredObject {
  readonly id: string;
  readonly geometry: UnknownRecord | null;
  readonly transform: UnknownRecord | null;
  readonly objectBounds: TargetMetricBounds;
  readonly worldAabb: [Vec3, Vec3];
  readonly objectSpec: PresetTextureSpecV2 | null;
  readonly regionLayers: readonly CompiledRegionLayer[];
  readonly scopedRegionRecord: UnknownRecord | null;
  readonly signature: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = asFiniteNumber(value[0]);
  const y = asFiniteNumber(value[1]);
  const z = asFiniteNumber(value[2]);
  return x !== null && y !== null && z !== null ? [x, y, z] : null;
}

function normalizeVec3(v: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len <= 1e-14) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function rotateByQuat(v: Vec3, q: readonly [number, number, number, number]): Vec3 {
  const qLen = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(qLen) || qLen <= 1e-14) return v;
  const qx = q[0] / qLen;
  const qy = q[1] / qLen;
  const qz = q[2] / qLen;
  const qw = q[3] / qLen;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

function readQuat(transform: UnknownRecord | null): [number, number, number, number] {
  const rawQuat = Array.isArray(transform?.rotation_quat) ? transform.rotation_quat : null;
  if (
    rawQuat &&
    rawQuat.length >= 4 &&
    rawQuat.slice(0, 4).every((c) => typeof c === "number" && Number.isFinite(c))
  ) {
    return [
      rawQuat[0] as number,
      rawQuat[1] as number,
      rawQuat[2] as number,
      rawQuat[3] as number,
    ];
  }
  return [0, 0, 0, 1];
}

function applyObjectTransformToPoint(pointLocal: Vec3, transform: UnknownRecord | null): Vec3 {
  if (!transform) return pointLocal;
  const scale = asVec3(transform.scale) ?? [1, 1, 1];
  const translation = asVec3(transform.translation) ?? [0, 0, 0];
  const pivot = asVec3(transform.pivot) ?? [0, 0, 0];
  const quat = readQuat(transform);
  const scaled: Vec3 = [
    (pointLocal[0] - pivot[0]) * scale[0],
    (pointLocal[1] - pivot[1]) * scale[1],
    (pointLocal[2] - pivot[2]) * scale[2],
  ];
  const rotated = rotateByQuat(scaled, quat);
  return [
    pivot[0] + rotated[0] + translation[0],
    pivot[1] + rotated[1] + translation[1],
    pivot[2] + rotated[2] + translation[2],
  ];
}

function inverseObjectTransformPoint(pointWorld: Vec3, transform: UnknownRecord | null): Vec3 {
  if (!transform) return pointWorld;
  const scale = asVec3(transform.scale) ?? [1, 1, 1];
  const translation = asVec3(transform.translation) ?? [0, 0, 0];
  const pivot = asVec3(transform.pivot) ?? [0, 0, 0];
  const quat = readQuat(transform);
  const invQuat: [number, number, number, number] = [-quat[0], -quat[1], -quat[2], quat[3]];
  const shifted: Vec3 = [
    pointWorld[0] - translation[0] - pivot[0],
    pointWorld[1] - translation[1] - pivot[1],
    pointWorld[2] - translation[2] - pivot[2],
  ];
  const unrotated = rotateByQuat(shifted, invQuat);
  return [
    (Math.abs(scale[0]) > 1e-14 ? unrotated[0] / scale[0] : unrotated[0]) + pivot[0],
    (Math.abs(scale[1]) > 1e-14 ? unrotated[1] / scale[1] : unrotated[1]) + pivot[1],
    (Math.abs(scale[2]) > 1e-14 ? unrotated[2] / scale[2] : unrotated[2]) + pivot[2],
  ];
}

function transformLocalAabbToWorld(
  localMin: Vec3,
  localMax: Vec3,
  transform: UnknownRecord | null,
): [Vec3, Vec3] {
  if (!transform) {
    return [
      [localMin[0], localMin[1], localMin[2]],
      [localMax[0], localMax[1], localMax[2]],
    ];
  }
  const minW: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maxW: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let ix = 0; ix < 2; ix += 1) {
    for (let iy = 0; iy < 2; iy += 1) {
      for (let iz = 0; iz < 2; iz += 1) {
        const corner: Vec3 = [
          ix === 0 ? localMin[0] : localMax[0],
          iy === 0 ? localMin[1] : localMax[1],
          iz === 0 ? localMin[2] : localMax[2],
        ];
        const world = applyObjectTransformToPoint(corner, transform);
        if (world[0] < minW[0]) minW[0] = world[0];
        if (world[1] < minW[1]) minW[1] = world[1];
        if (world[2] < minW[2]) minW[2] = world[2];
        if (world[0] > maxW[0]) maxW[0] = world[0];
        if (world[1] > maxW[1]) maxW[1] = world[1];
        if (world[2] > maxW[2]) maxW[2] = world[2];
      }
    }
  }
  return [minW, maxW];
}

function isFieldFileAsset(asset: UnknownRecord): boolean {
  const kind = asNonEmptyString(asset.kind)?.toLowerCase() ?? "";
  if (
    kind === "sampled" ||
    kind === "field_file" ||
    kind === "field-file" ||
    kind === "imported_field"
  ) {
    return true;
  }
  return asset.source_mode === "field-file";
}

function isMagneticSceneObject(obj: UnknownRecord): boolean {
  if (obj.visible === false) return false;
  const role = asNonEmptyString(obj.role)?.toLowerCase();
  return role === undefined || role === null || role === "magnet";
}

function findObjectMagnetizationAsset(
  sceneRec: UnknownRecord,
  objectRec: UnknownRecord,
): UnknownRecord | null {
  const refId = asNonEmptyString(objectRec.magnetization_ref);
  if (!refId || !Array.isArray(sceneRec.magnetization_assets)) return null;
  for (const rawAsset of sceneRec.magnetization_assets) {
    const asset = asRecord(rawAsset);
    if (asset && asNonEmptyString(asset.id) === refId) {
      return isFieldFileAsset(asset) ? null : asset;
    }
  }
  return null;
}

function objectHasAuthoredRegionOverride(objectRec: UnknownRecord): boolean {
  if (!Array.isArray(objectRec.regions)) return false;
  for (const rawRegion of objectRec.regions) {
    const region = asRecord(rawRegion);
    if (!region || region.enabled === false) continue;
    const init = asRecord(asRecord(region.texture_override)?.initial_magnetization);
    if (init && !isFieldFileAsset(init)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when the scene has at least one visible magnetic object with
 * a committed authored magnetization preset (object asset or enabled region
 * override), excluding external field-file assets.
 */
export function sceneHasAuthoredMagnetization(
  scene: SceneResource | null | undefined,
): boolean {
  const sceneRec = asRecord(scene);
  if (!sceneRec || !Array.isArray(sceneRec.objects)) return false;
  for (const rawObj of sceneRec.objects) {
    const obj = asRecord(rawObj);
    if (!obj || !isMagneticSceneObject(obj)) continue;
    if (objectHasAuthoredRegionOverride(obj)) return true;
    if (findObjectMagnetizationAsset(sceneRec, obj)) return true;
  }
  return false;
}

function resolveLocalGeometryAabb(
  shapeRaw: UnknownRecord | null,
  depth = 0,
): [Vec3, Vec3] | null {
  if (!shapeRaw || depth > 12) return null;
  const params = asRecord(shapeRaw.geometry_params) ?? asRecord(shapeRaw.params) ?? shapeRaw;
  const rawKind =
    (typeof shapeRaw.geometry_kind === "string" ? shapeRaw.geometry_kind : null) ??
    (typeof shapeRaw.kind === "string" ? shapeRaw.kind : null) ??
    (typeof shapeRaw.op === "string" ? shapeRaw.op : null) ??
    "";
  const kind = rawKind.trim().toLowerCase().replaceAll("-", "_");

  if (kind === "translate") {
    const offset = asVec3(params.translation) ?? [0, 0, 0];
    const base = asRecord(params.base) ?? asRecord(params.child);
    const childBox = resolveLocalGeometryAabb(base, depth + 1);
    if (!childBox) return null;
    return [
      [childBox[0][0] + offset[0], childBox[0][1] + offset[1], childBox[0][2] + offset[2]],
      [childBox[1][0] + offset[0], childBox[1][1] + offset[1], childBox[1][2] + offset[2]],
    ];
  }

  const center = asVec3(params.center) ?? asVec3(shapeRaw.center) ?? [0, 0, 0];

  if (kind === "box" || kind === "cuboid" || kind === "slab") {
    const size =
      asVec3(params.size) ??
      asVec3(params.dimensions) ??
      (() => {
        const lx = asFiniteNumber(params.lx) ?? asFiniteNumber(params.width) ?? asFiniteNumber(params.x);
        const ly = asFiniteNumber(params.ly) ?? asFiniteNumber(params.depth) ?? asFiniteNumber(params.y);
        const lz =
          asFiniteNumber(params.lz) ??
          asFiniteNumber(params.height) ??
          asFiniteNumber(params.thickness) ??
          asFiniteNumber(params.z);
        return lx !== null && ly !== null && lz !== null ? ([lx, ly, lz] as Vec3) : null;
      })();
    if (size) {
      return [
        [center[0] - 0.5 * Math.abs(size[0]), center[1] - 0.5 * Math.abs(size[1]), center[2] - 0.5 * Math.abs(size[2])],
        [center[0] + 0.5 * Math.abs(size[0]), center[1] + 0.5 * Math.abs(size[1]), center[2] + 0.5 * Math.abs(size[2])],
      ];
    }
  }

  if (kind === "sphere") {
    const r =
      asFiniteNumber(params.radius) ??
      (() => {
        const d = asFiniteNumber(params.diameter);
        return d !== null ? 0.5 * d : null;
      })();
    if (r !== null && r > 0) {
      return [
        [center[0] - r, center[1] - r, center[2] - r],
        [center[0] + r, center[1] + r, center[2] + r],
      ];
    }
  }

  if (kind === "ellipsoid") {
    const radii =
      asVec3(params.radii) ??
      asVec3(params.radii_m) ??
      asVec3(params.semi_axes) ??
      (() => {
        const rx = asFiniteNumber(params.rx) ?? asFiniteNumber(params.a);
        const ry = asFiniteNumber(params.ry) ?? asFiniteNumber(params.b);
        const rz = asFiniteNumber(params.rz) ?? asFiniteNumber(params.c);
        return rx !== null && ry !== null && rz !== null ? ([rx, ry, rz] as Vec3) : null;
      })() ??
      (() => {
        const sz = asVec3(params.size);
        return sz ? ([0.5 * sz[0], 0.5 * sz[1], 0.5 * sz[2]] as Vec3) : null;
      })();
    if (radii) {
      return [
        [center[0] - Math.abs(radii[0]), center[1] - Math.abs(radii[1]), center[2] - Math.abs(radii[2])],
        [center[0] + Math.abs(radii[0]), center[1] + Math.abs(radii[1]), center[2] + Math.abs(radii[2])],
      ];
    }
  }

  if (kind === "cylinder_cylinder_difference") {
    const rOut = asFiniteNumber(params.outer_radius) ?? asFiniteNumber(params.radius);
    const height = asFiniteNumber(params.height) ?? asFiniteNumber(params.thickness);
    if (rOut !== null && rOut > 0 && height !== null && height > 0) {
      const axis = normalizeVec3(asVec3(params.axis) ?? [0, 0, 1]);
      const min: Vec3 = [0, 0, 0];
      const max: Vec3 = [0, 0, 0];
      for (let i = 0 as 0 | 1 | 2; i < 3; i = (i + 1) as 0 | 1 | 2) {
        const ai = axis[i];
        const extent = 0.5 * height * Math.abs(ai) + rOut * Math.sqrt(Math.max(0, 1 - ai * ai));
        min[i] = center[i] - extent;
        max[i] = center[i] + extent;
      }
      return [min, max];
    }
  }

  if (
    kind === "cylinder" ||
    kind === "disc" ||
    kind === "disk" ||
    kind === "ring" ||
    kind === "tube" ||
    kind === "hollow_cylinder" ||
    kind === "annulus"
  ) {
    const rOut =
      asFiniteNumber(params.outer_radius) ??
      asFiniteNumber(params.radius) ??
      asFiniteNumber(params.r_out);
    const height =
      asFiniteNumber(params.height) ??
      asFiniteNumber(params.thickness) ??
      asFiniteNumber(params.length) ??
      asFiniteNumber(params.lz);
    if (rOut !== null && rOut > 0 && height !== null && height > 0) {
      const axis = normalizeVec3(asVec3(params.axis) ?? [0, 0, 1]);
      const min: Vec3 = [0, 0, 0];
      const max: Vec3 = [0, 0, 0];
      for (let i = 0 as 0 | 1 | 2; i < 3; i = (i + 1) as 0 | 1 | 2) {
        const ai = axis[i];
        const extent = 0.5 * height * Math.abs(ai) + rOut * Math.sqrt(Math.max(0, 1 - ai * ai));
        min[i] = center[i] - extent;
        max[i] = center[i] + extent;
      }
      return [min, max];
    }
  }

  const csgTree =
    asRecord(params.tree) ??
    asRecord(shapeRaw.tree) ??
    (kind === "csg" || kind === "union" || kind === "intersection" || kind === "difference"
      ? params
      : null);
  if (csgTree) {
    const op = String(csgTree.op ?? csgTree.operation ?? csgTree.kind ?? kind).toLowerCase();
    const children = Array.isArray(csgTree.children) ? csgTree.children.map(asRecord) : null;
    const left =
      asRecord(csgTree.base) ??
      asRecord(csgTree.left) ??
      asRecord(csgTree.a) ??
      (children?.[0] ?? null);
    const right =
      asRecord(csgTree.tool) ??
      asRecord(csgTree.right) ??
      asRecord(csgTree.b) ??
      (children?.[1] ?? null);
    const leftBox = resolveLocalGeometryAabb(left, depth + 1);
    const rightBox = resolveLocalGeometryAabb(right, depth + 1);
    if (op === "difference" && leftBox) return leftBox;
    if (op === "union" && leftBox) {
      const list = children && children.length > 0 ? children.slice(1) : [right];
      let acc = leftBox;
      for (const child of list) {
        const childBox = resolveLocalGeometryAabb(child, depth + 1);
        if (childBox) {
          acc = [
            [
              Math.min(acc[0][0], childBox[0][0]),
              Math.min(acc[0][1], childBox[0][1]),
              Math.min(acc[0][2], childBox[0][2]),
            ],
            [
              Math.max(acc[1][0], childBox[1][0]),
              Math.max(acc[1][1], childBox[1][1]),
              Math.max(acc[1][2], childBox[1][2]),
            ],
          ];
        }
      }
      return acc;
    }
    if (op === "intersection" && leftBox && rightBox) {
      return [
        [
          Math.max(leftBox[0][0], rightBox[0][0]),
          Math.max(leftBox[0][1], rightBox[0][1]),
          Math.max(leftBox[0][2], rightBox[0][2]),
        ],
        [
          Math.min(leftBox[1][0], rightBox[1][0]),
          Math.min(leftBox[1][1], rightBox[1][1]),
          Math.min(leftBox[1][2], rightBox[1][2]),
        ],
      ];
    }
    if (leftBox) return leftBox;
  }

  return null;
}

function pointInsideGeometryShape(
  point: Vec3,
  shapeRaw: UnknownRecord | null,
  boundaryEps: number,
  depth = 0,
): boolean | null {
  if (!shapeRaw || depth > 12) return null;
  const params = asRecord(shapeRaw.geometry_params) ?? asRecord(shapeRaw.params) ?? shapeRaw;
  const rawKind =
    (typeof shapeRaw.geometry_kind === "string" ? shapeRaw.geometry_kind : null) ??
    (typeof shapeRaw.kind === "string" ? shapeRaw.kind : null) ??
    (typeof shapeRaw.op === "string" ? shapeRaw.op : null) ??
    "";
  const kind = rawKind.trim().toLowerCase().replaceAll("-", "_");

  if (kind === "translate") {
    const offset = asVec3(params.translation) ?? [0, 0, 0];
    const base = asRecord(params.base) ?? asRecord(params.child);
    const shifted: Vec3 = [
      point[0] - offset[0],
      point[1] - offset[1],
      point[2] - offset[2],
    ];
    return pointInsideGeometryShape(shifted, base, boundaryEps, depth + 1);
  }

  const center = asVec3(params.center) ?? asVec3(shapeRaw.center) ?? [0, 0, 0];
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  const dz = point[2] - center[2];

  if (kind === "box" || kind === "cuboid" || kind === "slab") {
    const size =
      asVec3(params.size) ??
      asVec3(params.dimensions) ??
      (() => {
        const lx = asFiniteNumber(params.lx) ?? asFiniteNumber(params.width) ?? asFiniteNumber(params.x);
        const ly = asFiniteNumber(params.ly) ?? asFiniteNumber(params.depth) ?? asFiniteNumber(params.y);
        const lz =
          asFiniteNumber(params.lz) ??
          asFiniteNumber(params.height) ??
          asFiniteNumber(params.thickness) ??
          asFiniteNumber(params.z);
        return lx !== null && ly !== null && lz !== null ? ([lx, ly, lz] as Vec3) : null;
      })();
    if (!size) return null;
    return (
      Math.abs(dx) <= 0.5 * Math.abs(size[0]) + boundaryEps &&
      Math.abs(dy) <= 0.5 * Math.abs(size[1]) + boundaryEps &&
      Math.abs(dz) <= 0.5 * Math.abs(size[2]) + boundaryEps
    );
  }

  if (kind === "sphere") {
    const r =
      asFiniteNumber(params.radius) ??
      (() => {
        const d = asFiniteNumber(params.diameter);
        return d !== null ? 0.5 * d : null;
      })();
    if (r === null || r <= 0) return null;
    const limit = r + boundaryEps;
    return dx * dx + dy * dy + dz * dz <= limit * limit;
  }

  if (kind === "ellipsoid") {
    const radii =
      asVec3(params.radii) ??
      asVec3(params.radii_m) ??
      asVec3(params.semi_axes) ??
      (() => {
        const rx = asFiniteNumber(params.rx) ?? asFiniteNumber(params.a);
        const ry = asFiniteNumber(params.ry) ?? asFiniteNumber(params.b);
        const rz = asFiniteNumber(params.rz) ?? asFiniteNumber(params.c);
        return rx !== null && ry !== null && rz !== null ? ([rx, ry, rz] as Vec3) : null;
      })() ??
      (() => {
        const sz = asVec3(params.size);
        return sz ? ([0.5 * sz[0], 0.5 * sz[1], 0.5 * sz[2]] as Vec3) : null;
      })();
    if (!radii) return null;
    const rx = Math.max(Math.abs(radii[0]), MIN_EXTENT_M) + boundaryEps;
    const ry = Math.max(Math.abs(radii[1]), MIN_EXTENT_M) + boundaryEps;
    const rz = Math.max(Math.abs(radii[2]), MIN_EXTENT_M) + boundaryEps;
    const normSq = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
    return normSq <= 1 + 1e-9;
  }

  if (
    kind === "cylinder" ||
    kind === "disc" ||
    kind === "disk" ||
    kind === "ring" ||
    kind === "tube" ||
    kind === "hollow_cylinder" ||
    kind === "annulus"
  ) {
    const rOut =
      asFiniteNumber(params.outer_radius) ??
      asFiniteNumber(params.radius) ??
      asFiniteNumber(params.r_out) ??
      (() => {
        const d = asFiniteNumber(params.outer_diameter) ?? asFiniteNumber(params.diameter);
        return d !== null ? 0.5 * d : null;
      })();
    const rIn =
      asFiniteNumber(params.inner_radius) ??
      asFiniteNumber(params.r_in) ??
      0;
    const height =
      asFiniteNumber(params.height) ??
      asFiniteNumber(params.thickness) ??
      asFiniteNumber(params.length) ??
      asFiniteNumber(params.lz);
    if (rOut === null || rOut <= 0 || height === null || height <= 0) return null;
    const axis = normalizeVec3(asVec3(params.axis) ?? [0, 0, 1]);
    const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
    if (Math.abs(axial) > 0.5 * height + boundaryEps) return false;
    const rx = dx - axial * axis[0];
    const ry = dy - axial * axis[1];
    const rz = dz - axial * axis[2];
    const radialSq = rx * rx + ry * ry + rz * rz;
    const rOutLim = rOut + boundaryEps;
    const rInLim = Math.max(0, rIn - boundaryEps);
    return radialSq <= rOutLim * rOutLim && radialSq >= rInLim * rInLim;
  }

  if (kind === "cylinder_cylinder_difference") {
    const outerRadius = asFiniteNumber(params.outer_radius) ?? asFiniteNumber(params.radius);
    const innerRadius = asFiniteNumber(params.inner_radius) ?? 0;
    const height = asFiniteNumber(params.height) ?? asFiniteNumber(params.thickness);
    if (outerRadius === null || outerRadius <= 0 || height === null || height <= 0) return null;
    const axis = normalizeVec3(asVec3(params.axis) ?? [0, 0, 1]);
    const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
    if (Math.abs(axial) > 0.5 * height + boundaryEps) return false;
    const rx = dx - axial * axis[0];
    const ry = dy - axial * axis[1];
    const rz = dz - axial * axis[2];
    const radialSq = rx * rx + ry * ry + rz * rz;
    const rOutLim = outerRadius + boundaryEps;
    const rInLim = Math.max(0, innerRadius - boundaryEps);
    return radialSq <= rOutLim * rOutLim && radialSq >= rInLim * rInLim;
  }

  const csgTree =
    asRecord(params.tree) ??
    asRecord(shapeRaw.tree) ??
    (kind === "csg" || kind === "union" || kind === "intersection" || kind === "difference"
      ? params
      : null);
  if (csgTree) {
    const op = String(csgTree.op ?? csgTree.operation ?? csgTree.kind ?? kind).toLowerCase();
    const children = Array.isArray(csgTree.children) ? csgTree.children.map(asRecord) : null;
    const left =
      asRecord(csgTree.base) ??
      asRecord(csgTree.left) ??
      asRecord(csgTree.a) ??
      (children?.[0] ?? null);
    const right =
      asRecord(csgTree.tool) ??
      asRecord(csgTree.right) ??
      asRecord(csgTree.b) ??
      (children?.[1] ?? null);
    if (op === "difference" && left && right) {
      const inLeft = pointInsideGeometryShape(point, left, boundaryEps, depth + 1);
      if (inLeft === null) return null;
      if (!inLeft) return false;
      const inRight = pointInsideGeometryShape(point, right, 0, depth + 1);
      return inRight === null ? inLeft : !inRight;
    }
    if (op === "union") {
      const list = children && children.length > 0 ? children : [left, right];
      let anyResolved = false;
      for (const child of list) {
        const inside = pointInsideGeometryShape(point, child, boundaryEps, depth + 1);
        if (inside === true) return true;
        if (inside === false) anyResolved = true;
      }
      return anyResolved ? false : null;
    }
    if (op === "intersection") {
      const list = children && children.length > 0 ? children : [left, right];
      let anyResolved = false;
      for (const child of list) {
        const inside = pointInsideGeometryShape(point, child, boundaryEps, depth + 1);
        if (inside === false) return false;
        if (inside === true) anyResolved = true;
      }
      return anyResolved ? true : null;
    }
  }

  return null;
}

function pointInsideCompiledObject(
  worldPt: Vec3,
  compiled: CompiledAuthoredObject,
): boolean {
  const [wMin, wMax] = compiled.worldAabb;
  const maxSpan = Math.max(
    wMax[0] - wMin[0],
    wMax[1] - wMin[1],
    wMax[2] - wMin[2],
    MIN_EXTENT_M,
  );
  const eps = Math.max(1e-15, maxSpan * 1e-9);
  if (
    worldPt[0] < wMin[0] - eps ||
    worldPt[0] > wMax[0] + eps ||
    worldPt[1] < wMin[1] - eps ||
    worldPt[1] > wMax[1] + eps ||
    worldPt[2] < wMin[2] - eps ||
    worldPt[2] > wMax[2] + eps
  ) {
    return false;
  }

  const localPt = inverseObjectTransformPoint(worldPt, compiled.transform);
  const shapeHit = pointInsideGeometryShape(localPt, compiled.geometry, eps);
  const insideObject =
    shapeHit !== null
      ? shapeHit
      : localPt[0] >= compiled.objectBounds.localMin[0] - eps &&
        localPt[0] <= compiled.objectBounds.localMax[0] + eps &&
        localPt[1] >= compiled.objectBounds.localMin[1] - eps &&
        localPt[1] <= compiled.objectBounds.localMax[1] + eps &&
        localPt[2] >= compiled.objectBounds.localMin[2] - eps &&
        localPt[2] <= compiled.objectBounds.localMax[2] + eps;

  if (!insideObject) return false;
  if (compiled.scopedRegionRecord) {
    return pointInsideRegionShape(localPt, compiled.scopedRegionRecord, compiled.transform);
  }
  return true;
}

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveGridResolution(
  spanU: number,
  spanV: number,
  hint: readonly [number, number] | null | undefined,
): [number, number] {
  const hintW = hint && Number.isFinite(hint[0]) && hint[0] > 0 ? Math.round(hint[0]) : 0;
  const hintH = hint && Number.isFinite(hint[1]) && hint[1] > 0 ? Math.round(hint[1]) : 0;
  const maxHint = Math.max(hintW, hintH);
  const maxSide =
    maxHint > 0
      ? Math.min(MAX_GRID_SIDE, Math.max(MIN_GRID_SIDE, maxHint))
      : MAX_GRID_SIDE;
  const safeU = Math.max(spanU, MIN_EXTENT_M);
  const safeV = Math.max(spanV, MIN_EXTENT_M);
  const aspect = safeU / safeV;
  if (aspect >= 1) {
    const nx = maxSide;
    const ny = Math.min(maxSide, Math.max(MIN_GRID_SIDE, Math.round(maxSide / aspect)));
    return [nx, ny];
  }
  const ny = maxSide;
  const nx = Math.min(maxSide, Math.max(MIN_GRID_SIDE, Math.round(maxSide * aspect)));
  return [nx, ny];
}

function compileAuthoredObjects(
  scene: SceneResource,
  viewScope: FieldMapViewScope | null | undefined,
): CompiledAuthoredObject[] {
  if (viewScope?.kind === "airbox") return [];
  const sceneRec = asRecord(scene);
  if (!sceneRec || !Array.isArray(sceneRec.objects)) return [];

  const scopedObjectId =
    viewScope?.kind === "object" || viewScope?.kind === "region"
      ? asNonEmptyString(viewScope.scope_id)
      : null;
  const scopedRegionId =
    viewScope?.kind === "region" ? asNonEmptyString(viewScope.region_id) : null;

  const compiled: CompiledAuthoredObject[] = [];
  for (const rawObj of sceneRec.objects) {
    const obj = asRecord(rawObj);
    if (!obj || !isMagneticSceneObject(obj)) continue;
    const objectId = asNonEmptyString(obj.id);
    if (!objectId) continue;
    if (scopedObjectId && objectId !== scopedObjectId) continue;

    const objectBounds = resolveTargetBoundsMeters(scene, { kind: "object", objectId });
    const transform = asRecord(obj.transform);
    const asset = findObjectMagnetizationAsset(sceneRec, obj);
    let objectSpec: PresetTextureSpecV2 | null = null;
    if (asset) {
      const draft = hydrateMagneticTextureDraftFromInitializer(asset, objectBounds, "object");
      objectSpec = buildPresetSpecFromDraft(draft, objectBounds);
    }

    const regionLayers: CompiledRegionLayer[] = [];
    let scopedRegionRecord: UnknownRecord | null = null;
    const rawRegions = Array.isArray(obj.regions) ? obj.regions : [];
    for (const rawRegion of rawRegions) {
      const reg = asRecord(rawRegion);
      if (!reg || reg.enabled === false) continue;
      const regionId = asNonEmptyString(reg.region_id);
      if (!regionId) continue;
      if (scopedRegionId && regionId === scopedRegionId) {
        scopedRegionRecord = reg;
      }
      const init = asRecord(asRecord(reg.texture_override)?.initial_magnetization);
      if (!init || isFieldFileAsset(init)) continue;
      const regBounds = resolveTargetBoundsMeters(scene, {
        kind: "region",
        objectId,
        regionId,
      });
      const regDraft = hydrateMagneticTextureDraftFromInitializer(init, regBounds, "region", {
        inherited: false,
      });
      regionLayers.push({
        regionId,
        priority: asFiniteNumber(reg.priority) ?? 0,
        regionRecord: reg,
        spec: buildPresetSpecFromDraft(regDraft, regBounds),
        regionBounds: regBounds,
      });
    }
    regionLayers.sort((left, right) => right.priority - left.priority);

    if (!objectSpec && regionLayers.length === 0) continue;
    if (scopedRegionId && !scopedRegionRecord) continue;

    const geometry = asRecord(obj.geometry);
    const localGeomAabb = scopedRegionId === null ? resolveLocalGeometryAabb(geometry) : null;
    const boundsForAabb =
      scopedRegionId !== null
        ? resolveTargetBoundsMeters(scene, {
            kind: "region",
            objectId,
            regionId: scopedRegionId,
          })
        : objectBounds;
    const worldAabb = transformLocalAabbToWorld(
      localGeomAabb ? localGeomAabb[0] : boundsForAabb.localMin,
      localGeomAabb ? localGeomAabb[1] : boundsForAabb.localMax,
      transform,
    );

    const signature = JSON.stringify([
      objectId,
      obj.geometry ?? null,
      transform ?? null,
      objectSpec,
      regionLayers.map((layer) => [layer.regionId, layer.priority, layer.spec]),
    ]);

    compiled.push({
      id: objectId,
      geometry,
      transform,
      objectBounds,
      worldAabb,
      objectSpec,
      regionLayers,
      scopedRegionRecord,
      signature,
    });
  }

  return compiled;
}

function resolveScalarComponent(
  worldVectors: Float32Array,
  projectedVectors: Float64Array,
  mask: Uint8Array,
  component: string,
): Float64Array {
  if (isClientDerivablePlanarComponent(component)) {
    const derived = derivePlanarComponentScalar(worldVectors, component);
    for (let i = 0; i < derived.length; i += 1) {
      if (mask[i] !== PLANAR_OCCUPANCY.occupied) derived[i] = 0;
    }
    return derived;
  }

  const count = Math.floor(worldVectors.length / 3);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    if (mask[i] !== PLANAR_OCCUPANCY.occupied) continue;
    const u = projectedVectors[i * 3] ?? 0;
    const v = projectedVectors[i * 3 + 1] ?? 0;
    const n = projectedVectors[i * 3 + 2] ?? 0;
    switch (component) {
      case "u":
        out[i] = u;
        break;
      case "v":
        out[i] = v;
        break;
      case "normal":
        out[i] = n;
        break;
      case "in_plane_magnitude":
        out[i] = Math.hypot(u, v);
        break;
      case "orientation":
        out[i] = Math.atan2(v, u);
        break;
      default:
        out[i] = Math.hypot(
          worldVectors[i * 3] ?? 0,
          worldVectors[i * 3 + 1] ?? 0,
          worldVectors[i * 3 + 2] ?? 0,
        );
        break;
    }
  }
  return out;
}

/**
 * Evaluates a live 2D planar slice directly from committed authored
 * magnetization (`m₀`) in the scene before any backend solver step has been
 * materialized.
 */
export function buildAuthoredPlanarSample(
  input: AuthoredPlanarSampleInput,
): AuthoredPlanarSample | null {
  const { scene, plane, positionFraction, resolution, crop, viewScope } = input;
  if (!scene) return null;

  const objects = compileAuthoredObjects(scene, viewScope);
  if (objects.length === 0) return null;

  const combinedMin: Vec3 = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const combinedMax: Vec3 = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const obj of objects) {
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
      if (obj.worldAabb[0][axis] < combinedMin[axis]) combinedMin[axis] = obj.worldAabb[0][axis];
      if (obj.worldAabb[1][axis] > combinedMax[axis]) combinedMax[axis] = obj.worldAabb[1][axis];
    }
  }

  const axes = planarSectionAxes(plane);
  const uIndex = AXIS_INDEX[axes.u];
  const vIndex = AXIS_INDEX[axes.v];
  const normalIndex = AXIS_INDEX[axes.normal];

  const uAxis = AXIS_UNIT_VECTOR[axes.u];
  const vAxis = AXIS_UNIT_VECTOR[axes.v];
  const normal = AXIS_UNIT_VECTOR[axes.normal];

  const normalMin = combinedMin[normalIndex];
  const normalMax = combinedMax[normalIndex];
  const normalExtent = Math.max(0, normalMax - normalMin);
  const clampedFraction =
    normalExtent === 0
      ? 0.5
      : Number.isFinite(positionFraction)
        ? Math.min(1, Math.max(0, positionFraction))
        : 0.5;
  const resolvedCoord = normalMin + clampedFraction * normalExtent;

  const origin: [number, number, number] = [0, 0, 0];
  origin[normalIndex] = resolvedCoord;

  let fullUMin = combinedMin[uIndex];
  let fullUMax = combinedMax[uIndex];
  if (fullUMax - fullUMin < MIN_EXTENT_M) {
    const mid = 0.5 * (fullUMin + fullUMax);
    fullUMin = mid - 0.5 * MIN_EXTENT_M;
    fullUMax = mid + 0.5 * MIN_EXTENT_M;
  }
  let fullVMin = combinedMin[vIndex];
  let fullVMax = combinedMax[vIndex];
  if (fullVMax - fullVMin < MIN_EXTENT_M) {
    const mid = 0.5 * (fullVMin + fullVMax);
    fullVMin = mid - 0.5 * MIN_EXTENT_M;
    fullVMax = mid + 0.5 * MIN_EXTENT_M;
  }

  const fullBoundsUv: [number, number, number, number] = [
    fullUMin,
    fullUMax,
    fullVMin,
    fullVMax,
  ];

  let boundsUv: [number, number, number, number] = [...fullBoundsUv];
  if (
    crop &&
    Number.isFinite(crop.u_min_m) &&
    Number.isFinite(crop.u_max_m) &&
    Number.isFinite(crop.v_min_m) &&
    Number.isFinite(crop.v_max_m)
  ) {
    const clampedUMin = Math.max(fullUMin, Math.min(crop.u_min_m, crop.u_max_m));
    const clampedUMax = Math.min(fullUMax, Math.max(crop.u_min_m, crop.u_max_m));
    const clampedVMin = Math.max(fullVMin, Math.min(crop.v_min_m, crop.v_max_m));
    const clampedVMax = Math.min(fullVMax, Math.max(crop.v_min_m, crop.v_max_m));
    if (clampedUMax - clampedUMin > MIN_EXTENT_M && clampedVMax - clampedVMin > MIN_EXTENT_M) {
      boundsUv = [clampedUMin, clampedUMax, clampedVMin, clampedVMax];
    }
  }

  const spanU = boundsUv[1] - boundsUv[0];
  const spanV = boundsUv[3] - boundsUv[2];
  const [nx, ny] = resolveGridResolution(spanU, spanV, resolution);
  const pixelCount = nx * ny;

  const worldVectors = new Float32Array(pixelCount * 3);
  const mask = new Uint8Array(pixelCount);
  mask.fill(PLANAR_OCCUPANCY.empty);

  const du = spanU / nx;
  const dv = spanV / ny;
  let occupiedCount = 0;

  for (let row = 0; row < ny; row += 1) {
    const v = boundsUv[2] + (row + 0.5) * dv;
    for (let col = 0; col < nx; col += 1) {
      const u = boundsUv[0] + (col + 0.5) * du;
      const worldPt: Vec3 = [
        origin[0] + u * uAxis[0] + v * vAxis[0],
        origin[1] + u * uAxis[1] + v * vAxis[1],
        origin[2] + u * uAxis[2] + v * vAxis[2],
      ];

      let matched: CompiledAuthoredObject | null = null;
      for (let objIndex = 0; objIndex < objects.length; objIndex += 1) {
        const candidate = objects[objIndex]!;
        if (pointInsideCompiledObject(worldPt, candidate)) {
          matched = candidate;
          break;
        }
      }

      if (!matched) continue;

      const index = row * nx + col;
      mask[index] = PLANAR_OCCUPANCY.occupied;
      occupiedCount += 1;

      const positionObject: Vec3 = [
        worldPt[0] - matched.objectBounds.worldCenter[0],
        worldPt[1] - matched.objectBounds.worldCenter[1],
        worldPt[2] - matched.objectBounds.worldCenter[2],
      ];

      let chosenSpec: PresetTextureSpecV2 | null = matched.objectSpec;
      let chosenBounds: TargetMetricBounds = matched.objectBounds;
      for (const layer of matched.regionLayers) {
        if (pointInsideRegionShape(positionObject, layer.regionRecord, matched.transform)) {
          chosenSpec = layer.spec;
          chosenBounds = layer.regionBounds;
          break;
        }
      }

      const positionRegion: Vec3 = [
        worldPt[0] - chosenBounds.worldCenter[0],
        worldPt[1] - chosenBounds.worldCenter[1],
        worldPt[2] - chosenBounds.worldCenter[2],
      ];

      let spin: Vec3 = [1, 0, 0];
      if (chosenSpec) {
        try {
          spin = samplePresetTextureV2Client(
            chosenSpec,
            {
              positionObject,
              positionRegion,
              positionWorld: worldPt,
            },
            chosenBounds,
          );
        } catch {
          spin = [1, 0, 0];
        }
      }

      const base = index * 3;
      worldVectors[base] = spin[0];
      worldVectors[base + 1] = spin[1];
      worldVectors[base + 2] = spin[2];
    }
  }

  const frame: PlanarFrame = {
    normal,
    origin,
    uAxis,
    vAxis,
  };
  const resolvedComponent = asNonEmptyString(input.component) ?? "magnitude";
  const vectors = projectPlanarVectors(worldVectors, frame);
  const scalar = resolveScalarComponent(worldVectors, vectors, mask, resolvedComponent);

  let scalarMin = Number.POSITIVE_INFINITY;
  let scalarMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pixelCount; i += 1) {
    if (mask[i] !== PLANAR_OCCUPANCY.occupied) continue;
    const val = scalar[i]!;
    if (!Number.isFinite(val)) continue;
    if (val < scalarMin) scalarMin = val;
    if (val > scalarMax) scalarMax = val;
  }

  const sceneRevision = scene.revision ?? scene.scene_revision ?? 0;
  const contentHash = fnv1a32Hex(objects.map((o) => o.signature).join("|"));
  const scopeKey = `${viewScope?.kind ?? "monitor_target"}:${viewScope?.scope_id ?? ""}:${viewScope?.region_id ?? ""}`;
  const boundsKey = boundsUv.map((v) => v.toExponential(4)).join(",");
  const etag = `authored-m:${sceneRevision}:${contentHash}:${plane}:${clampedFraction.toFixed(4)}:${resolvedComponent}:${nx}x${ny}:${boundsKey}:${scopeKey}`;

  const section: PlanarFieldMetaResource["section"] =
    normalExtent > 0
      ? {
          cut_element_count: null,
          layer_count: null,
          layer_index: null,
          layer_spacing_m: null,
          layer_stops_m: [],
          navigation_step_kind: "extent_fraction",
          navigation_step_m: normalExtent * 0.01,
          normal_axis: axes.normal,
          normal_max_m: normalMax,
          normal_min_m: normalMin,
          plane,
          requested_coordinate_m: resolvedCoord,
          requested_fraction: clampedFraction,
          resolved_coordinate_m: resolvedCoord,
          stops_kind: "continuous",
        }
      : null;

  const meta: PlanarFieldMetaResource = {
    basis_order: 1,
    canonical_unit: "1",
    carrier_revision: String(sceneRevision),
    component: resolvedComponent,
    etag,
    field_backend: "client_authored",
    field_device: "cpu",
    field_precision: "float32",
    field_revision: String(sceneRevision),
    field_source: "authored_initial_state",
    fold_count: 0,
    frame: {
      bounds_uv_m: boundsUv,
      full_bounds_uv_m: fullBoundsUv,
      normal,
      origin_m: origin,
      u_axis: uAxis,
      v_axis: vAxis,
    },
    generation_id: "authored-initial-state",
    integration_order: 1,
    links: {
      empty_mask: "",
      mesh_overlay: "",
      probe: "",
      render_png: "",
      scalar: "",
      vectors: "",
    },
    mesh_overlay_descriptor: {
      available: false,
      boundary_classification: "none",
      codec: null,
      geometry_source: "none",
    },
    mesh_revision: "0",
    non_injective: false,
    observation_frame: null,
    occupancy: {
      empty: pixelCount - occupiedCount,
      occupied: occupiedCount,
      occupied_measure: pixelCount > 0 ? occupiedCount / pixelCount : 0,
      partial: 0,
    },
    operator: { kind: "plane_sample" },
    overlap_count: 0,
    pixel_size_m: [du, dv],
    quantity_id: "m",
    resolution: [nx, ny],
    sample_support: "authored_scene",
    sample_token: etag,
    sampler_version: "authored-v2",
    sampling_execution: "client",
    sampling_method: "authored_preset_v2",
    scalar_max: Number.isFinite(scalarMax) ? scalarMax : null,
    scalar_min: Number.isFinite(scalarMin) ? scalarMin : null,
    scene_revision: String(sceneRevision),
    schema_version: "2.0",
    scope_id: viewScope?.scope_id ?? null,
    scope_kind: viewScope?.kind ?? "monitor_target",
    scope_region_id: viewScope?.kind === "region" ? viewScope.region_id ?? null : null,
    section,
    source: {
      default_slice_hash: etag,
      default_slice_revision: String(sceneRevision),
      domain_generation_id: "authored-initial-state",
      kind: "default",
    },
  };

  return {
    frame,
    mask,
    meshOverlay: null,
    meta,
    sampleIdentity: etag,
    scalar,
    vectors,
    worldVectors,
  };
}
