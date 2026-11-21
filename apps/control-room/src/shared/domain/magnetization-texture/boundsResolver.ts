import type { SceneResource } from "@/kernel/api/apiTypes";

import type { MagnetizationTextureTarget } from "./types";

export type Vec3 = [number, number, number];

export interface TargetMetricBounds {
  /** Lower AABB corner in object-local coordinates [m]. */
  localMin: Vec3;
  /** Upper AABB corner in object-local coordinates [m]. */
  localMax: Vec3;
  /** AABB midpoint in object-local coordinates [m]. */
  localCenter: Vec3;
  /** Positive edge lengths [Lx, Ly, Lz] in meters (each >= 1e-12 m). */
  size: Vec3;
  /** AABB midpoint in world coordinates [m] after applying object.transform. */
  worldCenter: Vec3;
  /** Diagnostic provenance of the resolved metric box. */
  source:
    | "region-shape"
    | "object-primitive"
    | "realization-aabb"
    | "universe-fallback"
    | "nanoscale-default";
}

export interface RealizationBoundsMap {
  readonly [objectId: string]:
    | {
        readonly boundsMin: readonly [number, number, number];
        readonly boundsMax: readonly [number, number, number];
      }
    | undefined;
}

type UnknownRecord = Record<string, unknown>;

const MIN_EXTENT_METERS = 1e-12;
const NANOSCALE_FALLBACK_SIZE: Vec3 = [100e-9, 100e-9, 10e-9];

function asRecord(value: unknown): UnknownRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
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

function applyObjectTransformToPoint(pointLocal: Vec3, transform: UnknownRecord | null): Vec3 {
  if (!transform) return pointLocal;
  const scale = asVec3(transform.scale) ?? [1, 1, 1];
  const translation = asVec3(transform.translation) ?? [0, 0, 0];
  const rawQuat = Array.isArray(transform.rotation_quat) ? transform.rotation_quat : null;
  const quat: [number, number, number, number] =
    rawQuat &&
    rawQuat.length >= 4 &&
    rawQuat.slice(0, 4).every((c) => typeof c === "number" && Number.isFinite(c))
      ? [rawQuat[0] as number, rawQuat[1] as number, rawQuat[2] as number, rawQuat[3] as number]
      : [0, 0, 0, 1];
  const scaled: Vec3 = [
    pointLocal[0] * scale[0],
    pointLocal[1] * scale[1],
    pointLocal[2] * scale[2],
  ];
  const rotated = rotateByQuat(scaled, quat);
  return [
    rotated[0] + translation[0],
    rotated[1] + translation[1],
    rotated[2] + translation[2],
  ];
}

function inverseObjectTransformPoint(pointWorld: Vec3, transform: UnknownRecord | null): Vec3 {
  if (!transform) return pointWorld;
  const scale = asVec3(transform.scale) ?? [1, 1, 1];
  const translation = asVec3(transform.translation) ?? [0, 0, 0];
  const rawQuat = Array.isArray(transform.rotation_quat) ? transform.rotation_quat : null;
  const quat: [number, number, number, number] =
    rawQuat &&
    rawQuat.length >= 4 &&
    rawQuat.slice(0, 4).every((c) => typeof c === "number" && Number.isFinite(c))
      ? [
          -(rawQuat[0] as number),
          -(rawQuat[1] as number),
          -(rawQuat[2] as number),
          rawQuat[3] as number,
        ]
      : [0, 0, 0, 1];
  const shifted: Vec3 = [
    pointWorld[0] - translation[0],
    pointWorld[1] - translation[1],
    pointWorld[2] - translation[2],
  ];
  const unrotated = rotateByQuat(shifted, quat);
  return [
    Math.abs(scale[0]) > 1e-14 ? unrotated[0] / scale[0] : unrotated[0],
    Math.abs(scale[1]) > 1e-14 ? unrotated[1] / scale[1] : unrotated[1],
    Math.abs(scale[2]) > 1e-14 ? unrotated[2] / scale[2] : unrotated[2],
  ];
}

function finalizeBounds(
  minRaw: Vec3,
  maxRaw: Vec3,
  objectTransform: UnknownRecord | null,
  source: TargetMetricBounds["source"],
): TargetMetricBounds {
  const localMin: Vec3 = [
    Math.min(minRaw[0], maxRaw[0]),
    Math.min(minRaw[1], maxRaw[1]),
    Math.min(minRaw[2], maxRaw[2]),
  ];
  const localMax: Vec3 = [
    Math.max(minRaw[0], maxRaw[0]),
    Math.max(minRaw[1], maxRaw[1]),
    Math.max(minRaw[2], maxRaw[2]),
  ];
  const localCenter: Vec3 = [
    0.5 * (localMin[0] + localMax[0]),
    0.5 * (localMin[1] + localMax[1]),
    0.5 * (localMin[2] + localMax[2]),
  ];
  const size: Vec3 = [
    Math.max(localMax[0] - localMin[0], MIN_EXTENT_METERS),
    Math.max(localMax[1] - localMin[1], MIN_EXTENT_METERS),
    Math.max(localMax[2] - localMin[2], MIN_EXTENT_METERS),
  ];
  const adjustedMin: Vec3 = [
    localCenter[0] - 0.5 * size[0],
    localCenter[1] - 0.5 * size[1],
    localCenter[2] - 0.5 * size[2],
  ];
  const adjustedMax: Vec3 = [
    localCenter[0] + 0.5 * size[0],
    localCenter[1] + 0.5 * size[1],
    localCenter[2] + 0.5 * size[2],
  ];
  return {
    localMin: adjustedMin,
    localMax: adjustedMax,
    localCenter,
    size,
    worldCenter: applyObjectTransformToPoint(localCenter, objectTransform),
    source,
  };
}

function cylinderBounds(center: Vec3, axisRaw: Vec3, radius: number, height: number): [Vec3, Vec3] {
  const a = normalizeVec3(axisRaw, [0, 0, 1]);
  const r = Math.max(0, radius);
  const h = Math.max(0, height);
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let i = 0 as 0 | 1 | 2; i < 3; i = (i + 1) as 0 | 1 | 2) {
    const ai = a[i];
    const extent = 0.5 * h * Math.abs(ai) + r * Math.sqrt(Math.max(0, 1 - ai * ai));
    min[i] = center[i] - extent;
    max[i] = center[i] + extent;
  }
  return [min, max];
}

function intersectAabb(a: [Vec3, Vec3], b: [Vec3, Vec3]): [Vec3, Vec3] | null {
  const min: Vec3 = [
    Math.max(a[0][0], b[0][0]),
    Math.max(a[0][1], b[0][1]),
    Math.max(a[0][2], b[0][2]),
  ];
  const max: Vec3 = [
    Math.min(a[1][0], b[1][0]),
    Math.min(a[1][1], b[1][1]),
    Math.min(a[1][2], b[1][2]),
  ];
  if (min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2]) {
    return [min, max];
  }
  return null;
}

function unionAabb(a: [Vec3, Vec3], b: [Vec3, Vec3]): [Vec3, Vec3] {
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1]), Math.min(a[0][2], b[0][2])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1]), Math.max(a[1][2], b[1][2])],
  ];
}

function archWaveguideBounds(params: UnknownRecord): [Vec3, Vec3] | null {
  const center = asVec3(params.center) ?? [0, 0, 0];
  const innerRadius =
    asFiniteNumber(params.inner_radius) ??
    asFiniteNumber(params.radius) ??
    null;
  const width = asFiniteNumber(params.width) ?? asFiniteNumber(params.radial_width) ?? null;
  const outerRadius =
    asFiniteNumber(params.outer_radius) ??
    (innerRadius !== null && width !== null ? innerRadius + width : null);
  const thickness =
    asFiniteNumber(params.thickness) ??
    asFiniteNumber(params.height) ??
    asFiniteNumber(params.lz) ??
    10e-9;
  if (outerRadius === null || outerRadius <= 0) return null;

  const rIn = Math.max(0, innerRadius ?? 0);
  const rOut = Math.max(rIn, outerRadius);
  const startAngleDeg = asFiniteNumber(params.start_angle_deg);
  const endAngleDeg = asFiniteNumber(params.end_angle_deg);
  const startRad =
    asFiniteNumber(params.start_angle_rad) ??
    asFiniteNumber(params.phi_start) ??
    (startAngleDeg !== null ? (startAngleDeg * Math.PI) / 180 : 0);
  const spanDeg = asFiniteNumber(params.span_angle_deg) ?? asFiniteNumber(params.angle_deg);
  const endRad =
    asFiniteNumber(params.end_angle_rad) ??
    asFiniteNumber(params.phi_end) ??
    (endAngleDeg !== null
      ? (endAngleDeg * Math.PI) / 180
      : spanDeg !== null
        ? startRad + (spanDeg * Math.PI) / 180
        : Math.PI);

  const phi0 = Math.min(startRad, endRad);
  const phi1 = Math.max(startRad, endRad);
  const candidateAngles = [phi0, phi1];
  const firstQuarter = Math.ceil(phi0 / (0.5 * Math.PI));
  const lastQuarter = Math.floor(phi1 / (0.5 * Math.PI));
  for (let k = firstQuarter; k <= lastQuarter && candidateAngles.length < 16; k += 1) {
    candidateAngles.push(k * 0.5 * Math.PI);
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ang of candidateAngles) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const r of [rIn, rOut]) {
      const x = center[0] + r * c;
      const y = center[1] + r * s;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const halfZ = 0.5 * Math.max(thickness, MIN_EXTENT_METERS);
  return [
    [minX, minY, center[2] - halfZ],
    [maxX, maxY, center[2] + halfZ],
  ];
}

function resolveGeometryRecordBounds(geomRaw: UnknownRecord | null): [Vec3, Vec3] | null {
  if (!geomRaw) return null;

  const explicitMin = asVec3(geomRaw.bounds_min);
  const explicitMax = asVec3(geomRaw.bounds_max);
  if (explicitMin && explicitMax) {
    return [explicitMin, explicitMax];
  }

  const params = asRecord(geomRaw.geometry_params) ?? asRecord(geomRaw.params) ?? geomRaw;
  const rawKind =
    (typeof geomRaw.geometry_kind === "string" ? geomRaw.geometry_kind : null) ??
    (typeof geomRaw.kind === "string" ? geomRaw.kind : null) ??
    (typeof geomRaw.op === "string" ? geomRaw.op : null) ??
    "";
  const kind = rawKind.trim().toLowerCase().replaceAll("-", "_");
  const center = asVec3(params.center) ?? asVec3(geomRaw.center) ?? [0, 0, 0];

  if (kind === "box" || kind === "cuboid" || kind === "slab") {
    const sizeVec =
      asVec3(params.size) ??
      asVec3(params.dimensions) ??
      (() => {
        const lx = asFiniteNumber(params.lx) ?? asFiniteNumber(params.width) ?? asFiniteNumber(params.x);
        const ly = asFiniteNumber(params.ly) ?? asFiniteNumber(params.depth) ?? asFiniteNumber(params.y);
        const lz = asFiniteNumber(params.lz) ?? asFiniteNumber(params.height) ?? asFiniteNumber(params.thickness) ?? asFiniteNumber(params.z);
        return lx !== null && ly !== null && lz !== null ? ([lx, ly, lz] as Vec3) : null;
      })();
    if (sizeVec) {
      return [
        [center[0] - 0.5 * sizeVec[0], center[1] - 0.5 * sizeVec[1], center[2] - 0.5 * sizeVec[2]],
        [center[0] + 0.5 * sizeVec[0], center[1] + 0.5 * sizeVec[1], center[2] + 0.5 * sizeVec[2]],
      ];
    }
  }

  if (
    kind === "cylinder" ||
    kind === "disc" ||
    kind === "disk" ||
    kind === "ring" ||
    kind === "tube" ||
    kind === "hollow_cylinder" ||
    kind === "annulus" ||
    kind === "cone" ||
    kind === "frustum"
  ) {
    const rCandidates = [
      asFiniteNumber(params.outer_radius),
      asFiniteNumber(params.radius),
      asFiniteNumber(params.bottom_radius),
      asFiniteNumber(params.top_radius),
      asFiniteNumber(params.r_out),
      (() => {
        const d = asFiniteNumber(params.diameter) ?? asFiniteNumber(params.outer_diameter);
        return d !== null ? 0.5 * d : null;
      })(),
    ].filter((v): v is number => v !== null && v > 0);
    const maxR = rCandidates.length > 0 ? Math.max(...rCandidates) : null;
    const height =
      asFiniteNumber(params.height) ??
      asFiniteNumber(params.thickness) ??
      asFiniteNumber(params.length) ??
      asFiniteNumber(params.lz);
    const axis = asVec3(params.axis) ?? [0, 0, 1];
    if (maxR !== null && height !== null) {
      return cylinderBounds(center, axis, maxR, height);
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

  if (kind === "torus") {
    const majorR = asFiniteNumber(params.major_radius) ?? asFiniteNumber(params.radius);
    const minorR = asFiniteNumber(params.minor_radius) ?? asFiniteNumber(params.tube_radius);
    const axis = asVec3(params.axis) ?? [0, 0, 1];
    if (majorR !== null && minorR !== null && majorR > 0 && minorR > 0) {
      return cylinderBounds(center, axis, majorR + minorR, 2 * minorR);
    }
  }

  if (kind === "arch_waveguide" || kind === "arch") {
    const arch = archWaveguideBounds(params);
    if (arch) return arch;
  }

  if (
    kind === "polygon" ||
    kind === "polygon_prism" ||
    kind === "extruded_polygon" ||
    Array.isArray(params.vertices) ||
    Array.isArray(params.points)
  ) {
    const rawVertices = (Array.isArray(params.vertices) ? params.vertices : params.points) as unknown[];
    if (Array.isArray(rawVertices) && rawVertices.length >= 3) {
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const entry of rawVertices) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const x = asFiniteNumber(entry[0]);
          const y = asFiniteNumber(entry[1]);
          if (x !== null && y !== null) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        } else {
          const rec = asRecord(entry);
          const x = asFiniteNumber(rec?.x);
          const y = asFiniteNumber(rec?.y);
          if (x !== null && y !== null) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      if (Number.isFinite(minX) && Number.isFinite(minY)) {
        const height =
          asFiniteNumber(params.height) ??
          asFiniteNumber(params.thickness) ??
          asFiniteNumber(params.lz) ??
          10e-9;
        const zCenter = asFiniteNumber(params.z_center) ?? asFiniteNumber(params.z0) ?? center[2];
        return [
          [minX + center[0], minY + center[1], zCenter - 0.5 * height],
          [maxX + center[0], maxY + center[1], zCenter + 0.5 * height],
        ];
      }
    }
  }

  // Recursive CSG tree support (union / intersection / difference)
  const csgTree = asRecord(params.tree) ?? asRecord(geomRaw.tree) ?? (
    kind === "csg" || kind === "union" || kind === "intersection" || kind === "difference"
      ? params
      : null
  );
  if (csgTree) {
    const op = String(csgTree.op ?? csgTree.operation ?? csgTree.kind ?? kind).toLowerCase();
    const leftRec = asRecord(csgTree.left) ?? asRecord(csgTree.a) ?? (Array.isArray(csgTree.children) ? asRecord(csgTree.children[0]) : null);
    const rightRec = asRecord(csgTree.right) ?? asRecord(csgTree.b) ?? (Array.isArray(csgTree.children) ? asRecord(csgTree.children[1]) : null);
    const leftBounds = resolveGeometryRecordBounds(leftRec);
    const rightBounds = resolveGeometryRecordBounds(rightRec);
    if (op === "union" && leftBounds && rightBounds) {
      let acc = unionAabb(leftBounds, rightBounds);
      if (Array.isArray(csgTree.children)) {
        for (let idx = 2; idx < csgTree.children.length; idx += 1) {
          const childB = resolveGeometryRecordBounds(asRecord(csgTree.children[idx]));
          if (childB) acc = unionAabb(acc, childB);
        }
      }
      return acc;
    }
    if (op === "intersection" && leftBounds && rightBounds) {
      return intersectAabb(leftBounds, rightBounds) ?? leftBounds;
    }
    if (op === "difference" && leftBounds) {
      return leftBounds;
    }
    if (leftBounds) return leftBounds;
  }

  // Fallback check if size is directly present even without a recognized kind string
  const directSize = asVec3(params.size);
  if (directSize) {
    return [
      [center[0] - 0.5 * directSize[0], center[1] - 0.5 * directSize[1], center[2] - 0.5 * directSize[2]],
      [center[0] + 0.5 * directSize[0], center[1] + 0.5 * directSize[1], center[2] + 0.5 * directSize[2]],
    ];
  }

  return null;
}

function transformWorldBoxToLocal(
  worldBox: [Vec3, Vec3],
  objectTransform: UnknownRecord | null,
): [Vec3, Vec3] {
  if (!objectTransform) return worldBox;
  const [minW, maxW] = worldBox;
  const corners: Vec3[] = [
    [minW[0], minW[1], minW[2]],
    [maxW[0], minW[1], minW[2]],
    [minW[0], maxW[1], minW[2]],
    [maxW[0], maxW[1], minW[2]],
    [minW[0], minW[1], maxW[2]],
    [maxW[0], minW[1], maxW[2]],
    [minW[0], maxW[1], maxW[2]],
    [maxW[0], maxW[1], maxW[2]],
  ];
  const minL: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maxL: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const corner of corners) {
    const localPt = inverseObjectTransformPoint(corner, objectTransform);
    for (let i = 0 as 0 | 1 | 2; i < 3; i = (i + 1) as 0 | 1 | 2) {
      if (localPt[i] < minL[i]) minL[i] = localPt[i];
      if (localPt[i] > maxL[i]) maxL[i] = localPt[i];
    }
  }
  return [minL, maxL];
}

export function resolveTargetBoundsMeters(
  scene: SceneResource | null | undefined,
  target: MagnetizationTextureTarget,
  realizationBounds?: RealizationBoundsMap | null,
): TargetMetricBounds {
  const sceneRec = asRecord(scene);
  const objects = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
  const objRec =
    objects
      .map(asRecord)
      .find((entry) => entry && entry.id === target.objectId) ?? null;
  const objectTransform = asRecord(objRec?.transform);

  const primitiveBox = resolveGeometryRecordBounds(asRecord(objRec?.geometry));
  const realizationEntry = realizationBounds?.[target.objectId];
  const realizationBox: [Vec3, Vec3] | null = realizationEntry
    ? [
        [realizationEntry.boundsMin[0], realizationEntry.boundsMin[1], realizationEntry.boundsMin[2]],
        [realizationEntry.boundsMax[0], realizationEntry.boundsMax[1], realizationEntry.boundsMax[2]],
      ]
    : null;
  const objectBox = primitiveBox ?? realizationBox;

  if (target.kind === "region" && objRec && Array.isArray(objRec.regions)) {
    const regionRec =
      objRec.regions
        .map(asRecord)
        .find((r) => r && r.region_id === target.regionId) ?? null;
    const shapeRec = asRecord(regionRec?.shape);
    const rawRegionBox = resolveGeometryRecordBounds(shapeRec);
    if (rawRegionBox) {
      const frame = typeof regionRec?.frame === "string" ? regionRec.frame.toLowerCase() : "object";
      const localRegionBox =
        frame === "world"
          ? transformWorldBoxToLocal(rawRegionBox, objectTransform)
          : rawRegionBox;
      const clipped = objectBox ? intersectAabb(localRegionBox, objectBox) ?? localRegionBox : localRegionBox;
      return finalizeBounds(clipped[0], clipped[1], objectTransform, "region-shape");
    }
  }

  if (primitiveBox) {
    return finalizeBounds(primitiveBox[0], primitiveBox[1], objectTransform, "object-primitive");
  }

  if (realizationBox) {
    return finalizeBounds(realizationBox[0], realizationBox[1], objectTransform, "realization-aabb");
  }

  const universeRec = asRecord(sceneRec?.universe);
  const univMin = asVec3(universeRec?.bounds_min);
  const univMax = asVec3(universeRec?.bounds_max);
  if (univMin && univMax) {
    return finalizeBounds(univMin, univMax, objectTransform, "universe-fallback");
  }
  const univSize = asVec3(universeRec?.size);
  if (univSize) {
    const univCenter = asVec3(universeRec?.center) ?? [0, 0, 0];
    return finalizeBounds(
      [univCenter[0] - 0.5 * univSize[0], univCenter[1] - 0.5 * univSize[1], univCenter[2] - 0.5 * univSize[2]],
      [univCenter[0] + 0.5 * univSize[0], univCenter[1] + 0.5 * univSize[1], univCenter[2] + 0.5 * univSize[2]],
      objectTransform,
      "universe-fallback",
    );
  }

  return finalizeBounds(
    [
      -0.5 * NANOSCALE_FALLBACK_SIZE[0],
      -0.5 * NANOSCALE_FALLBACK_SIZE[1],
      -0.5 * NANOSCALE_FALLBACK_SIZE[2],
    ],
    [
      0.5 * NANOSCALE_FALLBACK_SIZE[0],
      0.5 * NANOSCALE_FALLBACK_SIZE[1],
      0.5 * NANOSCALE_FALLBACK_SIZE[2],
    ],
    objectTransform,
    "nanoscale-default",
  );
}

function pointInGeometryShape(point: Vec3, shapeRaw: UnknownRecord | null): boolean {
  if (!shapeRaw) return false;
  const params = asRecord(shapeRaw.geometry_params) ?? asRecord(shapeRaw.params) ?? shapeRaw;
  const kind = String(shapeRaw.geometry_kind ?? shapeRaw.kind ?? shapeRaw.op ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
  const center = asVec3(params.center) ?? [0, 0, 0];
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  const dz = point[2] - center[2];

  if (kind === "box" || kind === "cuboid" || kind === "slab") {
    const size = asVec3(params.size) ?? asVec3(params.dimensions);
    if (!size) return false;
    return (
      Math.abs(dx) <= 0.5 * size[0] + 1e-15 &&
      Math.abs(dy) <= 0.5 * size[1] + 1e-15 &&
      Math.abs(dz) <= 0.5 * size[2] + 1e-15
    );
  }

  if (kind === "sphere") {
    const r = asFiniteNumber(params.radius);
    if (r === null || r <= 0) return false;
    return dx * dx + dy * dy + dz * dz <= r * r * (1 + 1e-12);
  }

  if (kind === "cylinder" || kind === "disc" || kind === "disk" || kind === "ring") {
    const rOut = asFiniteNumber(params.outer_radius) ?? asFiniteNumber(params.radius);
    const rIn = asFiniteNumber(params.inner_radius) ?? 0;
    const height = asFiniteNumber(params.height) ?? asFiniteNumber(params.thickness);
    if (rOut === null || height === null) return false;
    const axis = normalizeVec3(asVec3(params.axis) ?? [0, 0, 1]);
    const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
    if (Math.abs(axial) > 0.5 * height + 1e-15) return false;
    const rx = dx - axial * axis[0];
    const ry = dy - axial * axis[1];
    const rz = dz - axial * axis[2];
    const radialSq = rx * rx + ry * ry + rz * rz;
    return radialSq <= rOut * rOut * (1 + 1e-12) && radialSq >= rIn * rIn * (1 - 1e-12);
  }

  const csgTree = asRecord(params.tree) ?? (
    kind === "csg" || kind === "union" || kind === "intersection" || kind === "difference"
      ? params
      : null
  );
  if (csgTree) {
    const op = String(csgTree.op ?? csgTree.operation ?? csgTree.kind ?? kind).toLowerCase();
    const left = asRecord(csgTree.left) ?? asRecord(csgTree.a);
    const right = asRecord(csgTree.right) ?? asRecord(csgTree.b);
    if (op === "union") {
      return pointInGeometryShape(point, left) || pointInGeometryShape(point, right);
    }
    if (op === "intersection") {
      return pointInGeometryShape(point, left) && pointInGeometryShape(point, right);
    }
    if (op === "difference") {
      return pointInGeometryShape(point, left) && !pointInGeometryShape(point, right);
    }
  }

  const box = resolveGeometryRecordBounds(shapeRaw);
  if (box) {
    return (
      point[0] >= box[0][0] - 1e-15 &&
      point[0] <= box[1][0] + 1e-15 &&
      point[1] >= box[0][1] - 1e-15 &&
      point[1] <= box[1][1] + 1e-15 &&
      point[2] >= box[0][2] - 1e-15 &&
      point[2] <= box[1][2] + 1e-15
    );
  }
  return false;
}

export function pointInsideRegionShape(
  pointObject: Vec3,
  regionRecord: unknown,
  objectTransform?: unknown,
): boolean {
  const region = asRecord(regionRecord);
  if (!region || region.enabled === false) return false;
  const shape = asRecord(region.shape);
  if (!shape) return false;
  const frame = typeof region.frame === "string" ? region.frame.toLowerCase() : "object";
  const testPt =
    frame === "world"
      ? applyObjectTransformToPoint(pointObject, asRecord(objectTransform))
      : pointObject;
  return pointInGeometryShape(testPt, shape);
}
