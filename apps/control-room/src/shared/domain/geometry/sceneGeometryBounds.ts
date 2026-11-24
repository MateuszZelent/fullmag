import {
  computeArray3DWorldBounds,
  parseArray3DGeometry,
  type Vec3Tuple,
} from "@/kernel/authoring/array3dModel";

export interface SceneGeometryBoundsMeters {
  readonly center: Vec3Tuple;
  readonly max: Vec3Tuple;
  readonly min: Vec3Tuple;
  readonly size: Vec3Tuple;
}

const MAX_GEOMETRY_BOUNDS_DEPTH = 16;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function asVec3(value: unknown): Vec3Tuple | null {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    typeof value[2] === "number" &&
    Number.isFinite(value[2])
  ) {
    return [value[0], value[1], value[2]];
  }
  return null;
}

function asVec4(value: unknown): [number, number, number, number] | null {
  if (
    Array.isArray(value) &&
    value.length >= 4 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    typeof value[2] === "number" &&
    Number.isFinite(value[2]) &&
    typeof value[3] === "number" &&
    Number.isFinite(value[3])
  ) {
    return [value[0], value[1], value[2], value[3]];
  }
  return null;
}

function makeBounds(min: Vec3Tuple, max: Vec3Tuple): SceneGeometryBoundsMeters {
  const size: Vec3Tuple = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];
  return {
    center: [
      min[0] + size[0] * 0.5,
      min[1] + size[1] * 0.5,
      min[2] + size[2] * 0.5,
    ],
    max,
    min,
    size,
  };
}

function centeredBounds(size: Vec3Tuple, center: Vec3Tuple = [0, 0, 0]): SceneGeometryBoundsMeters {
  const hx = Math.max(size[0], 0) * 0.5;
  const hy = Math.max(size[1], 0) * 0.5;
  const hz = Math.max(size[2], 0) * 0.5;
  return makeBounds(
    [center[0] - hx, center[1] - hy, center[2] - hz],
    [center[0] + hx, center[1] + hy, center[2] + hz],
  );
}

function parseAxisVector(raw: unknown): Vec3Tuple {
  if (raw === "x" || raw === "X") return [1, 0, 0];
  if (raw === "y" || raw === "Y") return [0, 1, 0];
  if (raw === "z" || raw === "Z") return [0, 0, 1];
  const vec = asVec3(raw);
  if (!vec) return [0, 0, 1];
  const norm = Math.hypot(vec[0], vec[1], vec[2]);
  return norm > 1e-12 ? [vec[0] / norm, vec[1] / norm, vec[2] / norm] : [0, 0, 1];
}

function cylinderOrientedSize(
  radius: number,
  height: number,
  axis: Vec3Tuple,
): Vec3Tuple {
  const ax = Math.abs(axis[0]);
  const ay = Math.abs(axis[1]);
  const az = Math.abs(axis[2]);
  return [
    Math.max(2 * (ax * (height * 0.5) + radius * Math.sqrt(Math.max(0, 1 - ax * ax))), 1e-12),
    Math.max(2 * (ay * (height * 0.5) + radius * Math.sqrt(Math.max(0, 1 - ay * ay))), 1e-12),
    Math.max(2 * (az * (height * 0.5) + radius * Math.sqrt(Math.max(0, 1 - az * az))), 1e-12),
  ];
}

function eulerXYZToQuat(rx: number, ry: number, rz: number): [number, number, number, number] {
  const c1 = Math.cos(rx * 0.5);
  const c2 = Math.cos(ry * 0.5);
  const c3 = Math.cos(rz * 0.5);
  const s1 = Math.sin(rx * 0.5);
  const s2 = Math.sin(ry * 0.5);
  const s3 = Math.sin(rz * 0.5);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function applyQuaternion(
  point: Vec3Tuple,
  quat: [number, number, number, number],
): Vec3Tuple {
  const len = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
  const qx = len > 1e-12 ? quat[0] / len : 0;
  const qy = len > 1e-12 ? quat[1] / len : 0;
  const qz = len > 1e-12 ? quat[2] / len : 0;
  const qw = len > 1e-12 ? quat[3] / len : 1;

  const [x, y, z] = point;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/**
 * Transform an axis-aligned bounding box by canonical `M = T(t + p) * R * S * T(-p)`.
 */
export function transformSceneGeometryBounds(
  bounds: SceneGeometryBoundsMeters,
  transform: unknown,
): SceneGeometryBoundsMeters {
  const tx = asRecord(transform);
  if (!tx) return bounds;

  const translation = asVec3(tx.translation ?? tx.offset ?? tx.delta) ?? [0, 0, 0];
  const scale = asVec3(tx.scale) ?? [1, 1, 1];
  const pivot = asVec3(tx.pivot) ?? [0, 0, 0];
  const rawQuat = asVec4(tx.rotation_quat ?? tx.rotationQuat);
  const rawEuler = !rawQuat ? asVec3(tx.rotation) : null;
  const quat: [number, number, number, number] | null = rawQuat
    ? rawQuat
    : rawEuler && rawEuler.some((v) => Math.abs(v) > 1e-12)
      ? eulerXYZToQuat(rawEuler[0], rawEuler[1], rawEuler[2])
      : null;

  const hasRotation = Boolean(
    quat &&
      (Math.abs(quat[0]) > 1e-12 ||
        Math.abs(quat[1]) > 1e-12 ||
        Math.abs(quat[2]) > 1e-12 ||
        Math.abs(Math.abs(quat[3]) - 1) > 1e-12),
  );
  const hasScale = scale.some((v) => Math.abs(v - 1) > 1e-12);
  const hasTranslation = translation.some((v) => Math.abs(v) > 1e-15);
  const hasPivot = pivot.some((v) => Math.abs(v) > 1e-15);

  if (!hasRotation && !hasScale && !hasTranslation) {
    return bounds;
  }

  if (!hasRotation && !hasScale) {
    return makeBounds(
      [
        bounds.min[0] + translation[0],
        bounds.min[1] + translation[1],
        bounds.min[2] + translation[2],
      ],
      [
        bounds.max[0] + translation[0],
        bounds.max[1] + translation[1],
        bounds.max[2] + translation[2],
      ],
    );
  }

  const xs = [bounds.min[0], bounds.max[0]];
  const ys = [bounds.min[1], bounds.max[1]];
  const zs = [bounds.min[2], bounds.max[2]];
  const min: Vec3Tuple = [Infinity, Infinity, Infinity];
  const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];

  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const px = hasPivot ? x - pivot[0] : x;
        const py = hasPivot ? y - pivot[1] : y;
        const pz = hasPivot ? z - pivot[2] : z;
        const scaled: Vec3Tuple = [px * scale[0], py * scale[1], pz * scale[2]];
        const rotated = hasRotation && quat ? applyQuaternion(scaled, quat) : scaled;
        const wx = rotated[0] + (hasPivot ? pivot[0] : 0) + translation[0];
        const wy = rotated[1] + (hasPivot ? pivot[1] : 0) + translation[1];
        const wz = rotated[2] + (hasPivot ? pivot[2] : 0) + translation[2];
        if (wx < min[0]) min[0] = wx;
        if (wy < min[1]) min[1] = wy;
        if (wz < min[2]) min[2] = wz;
        if (wx > max[0]) max[0] = wx;
        if (wy > max[1]) max[1] = wy;
        if (wz > max[2]) max[2] = wz;
      }
    }
  }

  return makeBounds(min, max);
}

function unionBoundsList(
  items: readonly SceneGeometryBoundsMeters[],
): SceneGeometryBoundsMeters | null {
  if (items.length === 0) return null;
  const min: Vec3Tuple = [...items[0]!.min];
  const max: Vec3Tuple = [...items[0]!.max];
  for (let i = 1; i < items.length; i += 1) {
    const entry = items[i]!;
    for (let c = 0; c < 3; c += 1) {
      if (entry.min[c]! < min[c]!) min[c] = entry.min[c]!;
      if (entry.max[c]! > max[c]!) max[c] = entry.max[c]!;
    }
  }
  return makeBounds(min, max);
}

function intersectBoundsList(
  items: readonly SceneGeometryBoundsMeters[],
): SceneGeometryBoundsMeters | null {
  if (items.length === 0) return null;
  const min: Vec3Tuple = [...items[0]!.min];
  const max: Vec3Tuple = [...items[0]!.max];
  for (let i = 1; i < items.length; i += 1) {
    const entry = items[i]!;
    for (let c = 0; c < 3; c += 1) {
      if (entry.min[c]! > min[c]!) min[c] = entry.min[c]!;
      if (entry.max[c]! < max[c]!) max[c] = entry.max[c]!;
    }
  }
  if (max[0] < min[0] || max[1] < min[1] || max[2] < min[2]) {
    return items[0]!;
  }
  return makeBounds(min, max);
}

function normalizeBooleanOp(
  kind: string,
  params: Record<string, unknown>,
): "union" | "difference" | "intersection" | "xor" | null {
  if (kind === "union") return "union";
  if (kind === "difference" || kind === "subtract") return "difference";
  if (kind === "intersection" || kind === "intersect") return "intersection";
  if (kind === "xor") return "xor";
  if (kind === "csg") {
    const op = (asString(params.op) ?? asString(params.operation) ?? "").toLowerCase();
    if (op === "union") return "union";
    if (op === "difference" || op === "subtract") return "difference";
    if (op === "intersection" || op === "intersect") return "intersection";
    if (op === "xor") return "xor";
  }
  return null;
}

function computeLocalSceneGeometryBoundsMeters(
  geometry: unknown,
  depth: number,
): SceneGeometryBoundsMeters | null {
  if (depth > MAX_GEOMETRY_BOUNDS_DEPTH) return null;
  const rec = asRecord(geometry);
  if (!rec) return null;

  const explicitMin = asVec3(rec.bounds_min ?? rec.min);
  const explicitMax = asVec3(rec.bounds_max ?? rec.max);
  if (explicitMin && explicitMax) {
    return makeBounds(explicitMin, explicitMax);
  }

  const rawKind = (asString(rec.geometry_kind) ?? asString(rec.kind) ?? "").toLowerCase();
  const params = asRecord(rec.geometry_params) ?? asRecord(rec.params) ?? rec;

  // Wrapper: Translate / Transform
  if (rawKind === "translate" || rawKind === "transform") {
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (!child) return null;
    const childBounds = computeLocalSceneGeometryBoundsMeters(child, depth + 1);
    if (!childBounds) return null;
    const innerTransform = asRecord(params.transform) ?? params;
    return transformSceneGeometryBounds(childBounds, innerTransform);
  }

  // Wrapper: SlicePlane
  if (rawKind === "sliceplane" || rawKind === "slice_plane") {
    const child = asRecord(params.child) ?? asRecord(params.base);
    return child ? computeLocalSceneGeometryBoundsMeters(child, depth + 1) : null;
  }

  // Wrapper: Array3D
  if (rawKind === "array3d" || rawKind === "array_3d") {
    const parsed = parseArray3DGeometry(rec);
    if (!parsed) return null;
    const rawChildBounds = computeLocalSceneGeometryBoundsMeters(parsed.child, depth + 1);
    if (!rawChildBounds) return null;
    const transformedChildBounds = parsed.childTransform
      ? transformSceneGeometryBounds(rawChildBounds, parsed.childTransform)
      : rawChildBounds;
    const arrayed = computeArray3DWorldBounds(parsed.axes, transformedChildBounds);
    return makeBounds(arrayed.min, arrayed.max);
  }

  // Compound Booleans: Union / Difference / Intersection / Xor
  const booleanOp = normalizeBooleanOp(rawKind, params);
  if (booleanOp) {
    const operandBounds: SceneGeometryBoundsMeters[] = [];

    if (Array.isArray(params.operands)) {
      for (const rawEntry of params.operands) {
        const entry = asRecord(rawEntry);
        if (!entry) continue;
        if (entry.enabled === false) continue;
        const childGeom = asRecord(entry.geometry) ?? entry;
        const childBounds = computeLocalSceneGeometryBoundsMeters(childGeom, depth + 1);
        if (!childBounds) continue;
        operandBounds.push(
          entry.transform
            ? transformSceneGeometryBounds(childBounds, entry.transform)
            : childBounds,
        );
      }
    } else {
      const legacyPairs: readonly (readonly [string, string])[] = [
        ["base", "tool"],
        ["a", "b"],
        ["left", "right"],
      ];
      for (const [firstKey, secondKey] of legacyPairs) {
        const first = asRecord(params[firstKey]);
        const second = asRecord(params[secondKey]);
        if (!first && !second) continue;
        if (first) {
          const b = computeLocalSceneGeometryBoundsMeters(first, depth + 1);
          if (b) operandBounds.push(b);
        }
        if (second) {
          const b = computeLocalSceneGeometryBoundsMeters(second, depth + 1);
          if (b) operandBounds.push(b);
        }
        break;
      }
    }

    if (operandBounds.length === 0) return null;
    if (booleanOp === "difference") return operandBounds[0]!;
    if (booleanOp === "intersection") return intersectBoundsList(operandBounds);
    return unionBoundsList(operandBounds);
  }

  // Primitives
  const center = asVec3(params.center ?? params.translation) ?? [0, 0, 0];

  if (rawKind === "box" || rawKind === "film" || rawKind === "cuboid") {
    const size = asVec3(params.size ?? params.dimensions);
    if (!size) return null;
    return centeredBounds(size, center);
  }

  if (rawKind === "sphere") {
    const radius = asPositiveNumber(params.radius);
    if (radius === null) return null;
    const d = radius * 2;
    return centeredBounds([d, d, d], center);
  }

  if (rawKind === "ellipsoid") {
    const radii = asVec3(params.radii);
    if (radii) {
      return centeredBounds([radii[0] * 2, radii[1] * 2, radii[2] * 2], center);
    }
    const size = asVec3(params.size ?? params.dimensions);
    return size ? centeredBounds(size, center) : null;
  }

  if (rawKind === "cylinder" || rawKind === "disk") {
    const radius = asPositiveNumber(params.radius);
    const height = asPositiveNumber(params.height ?? params.length ?? params.thickness);
    if (radius === null || height === null) return null;
    return centeredBounds(cylinderOrientedSize(radius, height, parseAxisVector(params.axis)), center);
  }

  if (rawKind === "tube" || rawKind === "ring" || rawKind === "hollowcylinder") {
    const outerRadius = asPositiveNumber(params.outer_radius ?? params.radius);
    const height = asPositiveNumber(params.height ?? params.length ?? params.thickness);
    if (outerRadius === null || height === null) return null;
    return centeredBounds(
      cylinderOrientedSize(outerRadius, height, parseAxisVector(params.axis)),
      center,
    );
  }

  if (rawKind === "cone" || rawKind === "frustum") {
    const rBottom = asNumber(params.radius_bottom ?? params.bottom_radius) ?? 0;
    const rTop = asNumber(params.radius_top ?? params.top_radius) ?? 0;
    const rFallback = asNumber(params.radius) ?? 0;
    const maxRadius = Math.max(rBottom, rTop, rFallback);
    const height = asPositiveNumber(params.height ?? params.length);
    if (maxRadius <= 0 || height === null) return null;
    return centeredBounds(
      cylinderOrientedSize(maxRadius, height, parseAxisVector(params.axis)),
      center,
    );
  }

  if (rawKind === "torus") {
    const major = asPositiveNumber(params.major_radius);
    const minor = asPositiveNumber(params.minor_radius);
    if (major === null || minor === null) return null;
    const outerR = major + minor;
    const thickness = minor * 2;
    return centeredBounds(
      cylinderOrientedSize(outerR, thickness, parseAxisVector(params.axis)),
      center,
    );
  }

  if (
    rawKind === "polygonprism" ||
    rawKind === "polygon_prism" ||
    rawKind === "polygonextrusion" ||
    rawKind === "extrudedpolygon" ||
    rawKind === "polygon"
  ) {
    const rawVerts = Array.isArray(params.vertices_xy)
      ? params.vertices_xy
      : Array.isArray(params.vertices)
        ? params.vertices
        : null;
    const height = asPositiveNumber(params.thickness ?? params.height) ?? 10e-9;
    if (!rawVerts || rawVerts.length === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pair of rawVerts) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const x = asNumber(pair[0]);
      const y = asNumber(pair[1]);
      if (x === null || y === null) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return makeBounds(
      [minX + center[0], minY + center[1], -height * 0.5 + center[2]],
      [maxX + center[0], maxY + center[1], height * 0.5 + center[2]],
    );
  }

  if (rawKind === "ellipse") {
    const rx = asPositiveNumber(params.rx ?? params.radius_x ?? params.semi_major);
    const ry = asPositiveNumber(params.ry ?? params.radius_y ?? params.semi_minor);
    const h = asPositiveNumber(params.height ?? params.thickness) ?? 10e-9;
    if (rx === null || ry === null) return null;
    return centeredBounds([rx * 2, ry * 2, h], center);
  }

  if (rawKind === "sinwaveguide" || rawKind === "sin_waveguide") {
    const length = asPositiveNumber(params.length);
    const width = asPositiveNumber(params.width);
    const height = asPositiveNumber(params.thickness ?? params.height);
    const amplitude = Math.abs(asNumber(params.amplitude) ?? 0);
    if (length === null || width === null || height === null) return null;
    return centeredBounds([length, width + 2 * amplitude, height], center);
  }

  if (rawKind === "archwaveguide" || rawKind === "arch_waveguide") {
    const length = asPositiveNumber(params.length);
    const width = asPositiveNumber(params.width);
    const height = asPositiveNumber(params.height ?? params.thickness);
    if (length === null || width === null || height === null) return null;
    const z0 = asNumber(params.z0) ?? 0;
    const arcRadius = asPositiveNumber(params.arc_radius);
    const arcAngle = asNumber(params.arc_angle_rad);
    const rise =
      params.profile_kind === "circular_arc" && arcRadius !== null && arcAngle !== null
        ? arcRadius * (1 - Math.cos(Math.abs(arcAngle) * 0.5))
        : Math.max(asNumber(params.arch_height) ?? 0, 0);
    return makeBounds(
      [-length * 0.5 + center[0], -width * 0.5 + center[1], z0 - height * 0.5 + center[2]],
      [length * 0.5 + center[0], width * 0.5 + center[1], z0 + height * 0.5 + rise + center[2]],
    );
  }

  // Generic fallback for unknown primitive records that still carry size/dimensions/radius
  const genericSize = asVec3(params.size ?? params.dimensions);
  if (genericSize) return centeredBounds(genericSize, center);
  const genericRadius = asPositiveNumber(params.radius);
  if (genericRadius !== null) {
    const d = genericRadius * 2;
    return centeredBounds([d, d, d], center);
  }

  return null;
}

/**
 * Recursively computes axis-aligned bounds (in meters) for any canonical `SceneGeometry`
 * including primitives, `Translate`/`Transform`, `Union`/`Difference`/`Intersection`/`Xor`
 * (both `operands[]` and legacy `base`/`tool`), `SlicePlane`, and `Array3D`.
 */
export function computeSceneGeometryBoundsMeters(
  geometry: unknown,
  transform?: unknown,
): SceneGeometryBoundsMeters | null {
  const local = computeLocalSceneGeometryBoundsMeters(geometry, 0);
  if (!local) return null;
  return transform ? transformSceneGeometryBounds(local, transform) : local;
}
