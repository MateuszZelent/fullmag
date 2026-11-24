import {
  computeArray3DInstanceTransforms,
  MAX_ARRAY_INSTANCES_FEM_OCC,
  parseArray3DGeometry,
  type Vec3Tuple,
} from "@/kernel/authoring/array3dModel";

import {
  computeSceneGeometryBoundsMeters,
  transformSceneGeometryBounds,
  type SceneGeometryBoundsMeters,
} from "./sceneGeometryBounds";

export type SceneGeometryContainmentTester = (
  pointLocalMeters: readonly [number, number, number],
) => boolean;

const MAX_CONTAINMENT_DEPTH = 16;
const ABS_TOLERANCE = 1e-15;
const REL_TOLERANCE = 1e-7;

interface CompiledInverseTransform {
  readonly hasPivot: boolean;
  readonly hasRotation: boolean;
  readonly hasScale: boolean;
  readonly hasTranslation: boolean;
  readonly invQuat: readonly [number, number, number, number];
  readonly invScale: readonly [number, number, number];
  readonly isSingular: boolean;
  readonly pivot: Vec3Tuple;
  readonly translation: Vec3Tuple;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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

function parseAxisVector(raw: unknown): Vec3Tuple {
  if (raw === "x" || raw === "X") return [1, 0, 0];
  if (raw === "y" || raw === "Y") return [0, 1, 0];
  if (raw === "z" || raw === "Z") return [0, 0, 1];
  const vec = asVec3(raw);
  if (!vec) return [0, 0, 1];
  const norm = Math.hypot(vec[0], vec[1], vec[2]);
  return norm > 1e-12 ? [vec[0] / norm, vec[1] / norm, vec[2] / norm] : [0, 0, 1];
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
  point: readonly [number, number, number],
  quat: readonly [number, number, number, number],
): Vec3Tuple {
  const [qx, qy, qz, qw] = quat;
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

function compileInverseTransform(transform: unknown): CompiledInverseTransform | null {
  const tx = asRecord(transform);
  if (!tx) return null;

  const translation = asVec3(tx.translation ?? tx.offset ?? tx.delta) ?? [0, 0, 0];
  const scale = asVec3(tx.scale) ?? [1, 1, 1];
  const pivot = asVec3(tx.pivot) ?? [0, 0, 0];
  const rawQuat = asVec4(tx.rotation_quat ?? tx.rotationQuat);
  const rawEuler = !rawQuat ? asVec3(tx.rotation) : null;
  const rawEulerDeg = !rawQuat && !rawEuler ? asVec3(tx.rotation_euler_deg ?? tx.rotationEulerDeg) : null;

  let quat: [number, number, number, number] = [0, 0, 0, 1];
  if (rawQuat) {
    const len = Math.hypot(rawQuat[0], rawQuat[1], rawQuat[2], rawQuat[3]);
    if (len > 1e-12) {
      quat = [rawQuat[0] / len, rawQuat[1] / len, rawQuat[2] / len, rawQuat[3] / len];
    }
  } else if (rawEuler && rawEuler.some((v) => Math.abs(v) > 1e-12)) {
    quat = eulerXYZToQuat(rawEuler[0], rawEuler[1], rawEuler[2]);
  } else if (rawEulerDeg && rawEulerDeg.some((v) => Math.abs(v) > 1e-12)) {
    const deg2rad = Math.PI / 180;
    quat = eulerXYZToQuat(
      rawEulerDeg[0] * deg2rad,
      rawEulerDeg[1] * deg2rad,
      rawEulerDeg[2] * deg2rad,
    );
  }

  const hasRotation =
    Math.abs(quat[0]) > 1e-12 ||
    Math.abs(quat[1]) > 1e-12 ||
    Math.abs(quat[2]) > 1e-12 ||
    Math.abs(Math.abs(quat[3]) - 1) > 1e-12;
  const hasScale = scale.some((v) => Math.abs(v - 1) > 1e-12);
  const hasTranslation = translation.some((v) => Math.abs(v) > 1e-15);
  const hasPivot = pivot.some((v) => Math.abs(v) > 1e-15);

  if (!hasRotation && !hasScale && !hasTranslation) {
    return null;
  }

  const isSingular = scale.some((v) => Math.abs(v) <= 1e-15);
  const invScale: [number, number, number] = isSingular
    ? [1, 1, 1]
    : [1 / scale[0], 1 / scale[1], 1 / scale[2]];

  return {
    hasPivot,
    hasRotation,
    hasScale,
    hasTranslation,
    invQuat: [-quat[0], -quat[1], -quat[2], quat[3]],
    invScale,
    isSingular,
    pivot,
    translation,
  };
}

function applyCompiledInverseTransform(
  point: readonly [number, number, number],
  inv: CompiledInverseTransform,
): Vec3Tuple | null {
  if (inv.isSingular) return null;
  let x = point[0] - inv.translation[0];
  let y = point[1] - inv.translation[1];
  let z = point[2] - inv.translation[2];
  if (inv.hasPivot) {
    x -= inv.pivot[0];
    y -= inv.pivot[1];
    z -= inv.pivot[2];
  }
  if (inv.hasRotation) {
    const r = applyQuaternion([x, y, z], inv.invQuat);
    x = r[0];
    y = r[1];
    z = r[2];
  }
  if (inv.hasScale) {
    x *= inv.invScale[0];
    y *= inv.invScale[1];
    z *= inv.invScale[2];
  }
  if (inv.hasPivot) {
    x += inv.pivot[0];
    y += inv.pivot[1];
    z += inv.pivot[2];
  }
  return [x, y, z];
}

function wrapWithInverseTransform(
  tester: SceneGeometryContainmentTester,
  transform: unknown,
): SceneGeometryContainmentTester {
  const inv = compileInverseTransform(transform);
  if (!inv) return tester;
  return (point) => {
    const local = applyCompiledInverseTransform(point, inv);
    return local ? tester(local) : false;
  };
}

function pointInBounds(
  point: readonly [number, number, number],
  bounds: SceneGeometryBoundsMeters,
  eps: number,
): boolean {
  return (
    point[0] >= bounds.min[0] - eps &&
    point[0] <= bounds.max[0] + eps &&
    point[1] >= bounds.min[1] - eps &&
    point[1] <= bounds.max[1] + eps &&
    point[2] >= bounds.min[2] - eps &&
    point[2] <= bounds.max[2] + eps
  );
}

function pointInPolygon2D(
  px: number,
  py: number,
  vertices: readonly (readonly [number, number])[],
  eps: number,
): boolean {
  const n = vertices.length;
  if (n < 3) return false;
  const epsSq = eps * eps;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [xi, yi] = vertices[i]!;
    const [xj, yj] = vertices[j]!;

    // On-edge tolerance check
    const ex = xi - xj;
    const ey = yi - yj;
    const lenSq = ex * ex + ey * ey;
    if (lenSq > 0) {
      const t = Math.max(0, Math.min(1, ((px - xj) * ex + (py - yj) * ey) / lenSq));
      const projX = xj + t * ex;
      const projY = yj + t * ey;
      const dx = px - projX;
      const dy = py - projY;
      if (dx * dx + dy * dy <= epsSq) {
        return true;
      }
    }

    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
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

function compileNode(geometry: unknown, depth: number): SceneGeometryContainmentTester {
  if (depth > MAX_CONTAINMENT_DEPTH) return () => false;
  const rec = asRecord(geometry);
  if (!rec) return () => false;

  const rawKind = (asString(rec.geometry_kind) ?? asString(rec.kind) ?? asString(rec.op) ?? "")
    .toLowerCase()
    .replaceAll("-", "_");
  const params = asRecord(rec.geometry_params) ?? asRecord(rec.params) ?? rec;

  // Wrapper: Translate / Transform
  if (rawKind === "translate" || rawKind === "transform") {
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (!child) return () => false;
    const innerTx = asRecord(params.transform) ?? params;
    return wrapWithInverseTransform(compileNode(child, depth + 1), innerTx);
  }

  // Wrapper: SlicePlane
  if (rawKind === "sliceplane" || rawKind === "slice_plane") {
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (!child) return () => false;
    const childTester = compileNode(child, depth + 1);
    const normal = parseAxisVector(params.plane_normal ?? params.normal ?? [1, 0, 0]);
    const origin = asVec3(params.plane_origin_m ?? params.plane_origin ?? params.origin) ?? [0, 0, 0];
    const keepSide = (asString(params.keep_side ?? params.keepSide) ?? "positive").toLowerCase();
    const keepNegative = keepSide === "negative" || keepSide === "minus" || keepSide === "-";
    const childBounds = computeSceneGeometryBoundsMeters(child);
    const maxDim = childBounds ? Math.max(...childBounds.size, 1e-12) : 1e-6;
    const eps = maxDim * REL_TOLERANCE + ABS_TOLERANCE;
    return (point) => {
      const signed =
        (point[0] - origin[0]) * normal[0] +
        (point[1] - origin[1]) * normal[1] +
        (point[2] - origin[2]) * normal[2];
      if (keepNegative ? signed > eps : signed < -eps) return false;
      return childTester(point);
    };
  }

  // Wrapper: Array3D
  if (rawKind === "array3d" || rawKind === "array_3d") {
    const parsed = parseArray3DGeometry(rec);
    if (!parsed) return () => false;
    const childTester = compileNode(parsed.child, depth + 1);
    const rawChildBounds = computeSceneGeometryBoundsMeters(parsed.child);
    const childBoundsWithTx = parsed.childTransform && rawChildBounds
      ? transformSceneGeometryBounds(rawChildBounds, parsed.childTransform)
      : rawChildBounds;
    const childSize: Vec3Tuple = childBoundsWithTx
      ? [
          Math.max(childBoundsWithTx.size[0], 1e-12),
          Math.max(childBoundsWithTx.size[1], 1e-12),
          Math.max(childBoundsWithTx.size[2], 1e-12),
        ]
      : [50e-9, 50e-9, 10e-9];
    const instances = computeArray3DInstanceTransforms(
      parsed.axes,
      childSize,
      MAX_ARRAY_INSTANCES_FEM_OCC,
    );
    const childInv = compileInverseTransform(parsed.childTransform);
    const overallBounds = computeSceneGeometryBoundsMeters(rec);
    const overallEps = overallBounds
      ? Math.max(...overallBounds.size, 1e-12) * REL_TOLERANCE + ABS_TOLERANCE
      : ABS_TOLERANCE;

    const compiledInstances = instances.map((inst) => {
      const instTx = {
        rotationEulerDeg: inst.rotationEulerDeg,
        scale: inst.scale,
        translation: inst.translation,
      };
      const invInst = compileInverseTransform(instTx);
      const instBounds = childBoundsWithTx
        ? transformSceneGeometryBounds(childBoundsWithTx, {
            rotation: [
              (inst.rotationEulerDeg[0] * Math.PI) / 180,
              (inst.rotationEulerDeg[1] * Math.PI) / 180,
              (inst.rotationEulerDeg[2] * Math.PI) / 180,
            ],
            scale: inst.scale,
            translation: inst.translation,
          })
        : null;
      const instEps = instBounds
        ? Math.max(...instBounds.size, 1e-12) * REL_TOLERANCE + ABS_TOLERANCE
        : ABS_TOLERANCE;
      return { instBounds, instEps, invInst };
    });

    return (point) => {
      if (overallBounds && !pointInBounds(point, overallBounds, overallEps)) {
        return false;
      }
      for (const entry of compiledInstances) {
        if (entry.instBounds && !pointInBounds(point, entry.instBounds, entry.instEps)) {
          continue;
        }
        let localPt: Vec3Tuple | null = [point[0], point[1], point[2]];
        if (entry.invInst) {
          localPt = applyCompiledInverseTransform(localPt, entry.invInst);
          if (!localPt) continue;
        }
        if (childInv) {
          localPt = applyCompiledInverseTransform(localPt, childInv);
          if (!localPt) continue;
        }
        if (childTester(localPt)) return true;
      }
      return false;
    };
  }

  // Compound Booleans: Union / Difference / Intersection / Xor
  const booleanOp = normalizeBooleanOp(rawKind, params);
  if (booleanOp) {
    const operandTesters: SceneGeometryContainmentTester[] = [];

    if (Array.isArray(params.operands)) {
      for (const rawEntry of params.operands) {
        const entry = asRecord(rawEntry);
        if (!entry || entry.enabled === false) continue;
        const childGeom = asRecord(entry.geometry) ?? entry;
        const tester = compileNode(childGeom, depth + 1);
        operandTesters.push(wrapWithInverseTransform(tester, entry.transform));
      }
    } else if (Array.isArray(params.children)) {
      for (const rawChild of params.children) {
        const child = asRecord(rawChild);
        if (!child) continue;
        operandTesters.push(compileNode(child, depth + 1));
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
        if (first) operandTesters.push(compileNode(first, depth + 1));
        if (second) operandTesters.push(compileNode(second, depth + 1));
        break;
      }
    }

    if (operandTesters.length === 0) return () => false;

    if (booleanOp === "difference") {
      const baseTester = operandTesters[0]!;
      const cutterTesters = operandTesters.slice(1);
      return (point) => {
        if (!baseTester(point)) return false;
        for (const cutter of cutterTesters) {
          if (cutter(point)) return false;
        }
        return true;
      };
    }

    if (booleanOp === "union") {
      return (point) => {
        for (const tester of operandTesters) {
          if (tester(point)) return true;
        }
        return false;
      };
    }

    if (booleanOp === "intersection") {
      return (point) => {
        for (const tester of operandTesters) {
          if (!tester(point)) return false;
        }
        return true;
      };
    }

    // Xor: odd parity
    return (point) => {
      let count = 0;
      for (const tester of operandTesters) {
        if (tester(point)) count += 1;
      }
      return (count & 1) === 1;
    };
  }

  // Primitives
  const center = asVec3(params.translation ?? params.center) ?? [0, 0, 0];

  if (rawKind === "box" || rawKind === "film" || rawKind === "cuboid" || rawKind === "slab") {
    const size = asVec3(params.size ?? params.dimensions);
    if (!size || !size.every((v) => v > 0)) return () => false;
    const hx = size[0] * 0.5;
    const hy = size[1] * 0.5;
    const hz = size[2] * 0.5;
    const eps = Math.max(size[0], size[1], size[2]) * REL_TOLERANCE + ABS_TOLERANCE;
    return (point) =>
      Math.abs(point[0] - center[0]) <= hx + eps &&
      Math.abs(point[1] - center[1]) <= hy + eps &&
      Math.abs(point[2] - center[2]) <= hz + eps;
  }

  if (rawKind === "sphere") {
    const radius = asPositiveNumber(params.radius);
    if (radius === null) return () => false;
    const rTol = radius + radius * REL_TOLERANCE + ABS_TOLERANCE;
    const rSq = rTol * rTol;
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      return dx * dx + dy * dy + dz * dz <= rSq;
    };
  }

  if (rawKind === "ellipsoid") {
    const radii =
      asVec3(params.radii) ??
      (() => {
        const size = asVec3(params.size ?? params.dimensions);
        return size ? ([size[0] * 0.5, size[1] * 0.5, size[2] * 0.5] as Vec3Tuple) : null;
      })();
    if (!radii || !radii.every((v) => v > 0)) return () => false;
    const invRx = 1 / radii[0];
    const invRy = 1 / radii[1];
    const invRz = 1 / radii[2];
    const limit = 1 + REL_TOLERANCE * 2;
    return (point) => {
      const nx = (point[0] - center[0]) * invRx;
      const ny = (point[1] - center[1]) * invRy;
      const nz = (point[2] - center[2]) * invRz;
      return nx * nx + ny * ny + nz * nz <= limit;
    };
  }

  if (rawKind === "cylinder" || rawKind === "disk" || rawKind === "disc") {
    const radius = asPositiveNumber(params.radius);
    const height = asPositiveNumber(params.height ?? params.length ?? params.thickness);
    if (radius === null || height === null) return () => false;
    const axis = parseAxisVector(params.axis);
    const halfH = height * 0.5;
    const eps = Math.max(radius, height) * REL_TOLERANCE + ABS_TOLERANCE;
    const rSq = (radius + eps) * (radius + eps);
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
      if (Math.abs(axial) > halfH + eps) return false;
      const rx = dx - axial * axis[0];
      const ry = dy - axial * axis[1];
      const rz = dz - axial * axis[2];
      return rx * rx + ry * ry + rz * rz <= rSq;
    };
  }

  if (
    rawKind === "tube" ||
    rawKind === "ring" ||
    rawKind === "hollowcylinder" ||
    rawKind === "hollow_cylinder" ||
    rawKind === "annulus"
  ) {
    const outerR = asPositiveNumber(params.outer_radius ?? params.radius);
    const innerR = Math.max(0, asNumber(params.inner_radius) ?? 0);
    const height = asPositiveNumber(params.height ?? params.length ?? params.thickness);
    if (outerR === null || height === null) return () => false;
    const axis = parseAxisVector(params.axis);
    const halfH = height * 0.5;
    const eps = Math.max(outerR, height) * REL_TOLERANCE + ABS_TOLERANCE;
    const outerSq = (outerR + eps) * (outerR + eps);
    const innerTol = Math.max(0, innerR - eps);
    const innerSq = innerTol * innerTol;
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
      if (Math.abs(axial) > halfH + eps) return false;
      const rx = dx - axial * axis[0];
      const ry = dy - axial * axis[1];
      const rz = dz - axial * axis[2];
      const radialSq = rx * rx + ry * ry + rz * rz;
      return radialSq <= outerSq && radialSq >= innerSq;
    };
  }

  if (rawKind === "cone" || rawKind === "frustum") {
    const rBottom = Math.max(0, asNumber(params.radius_bottom ?? params.bottom_radius ?? params.radius) ?? 0);
    const rTop = Math.max(0, asNumber(params.radius_top ?? params.top_radius) ?? 0);
    const height = asPositiveNumber(params.height ?? params.length);
    const maxR = Math.max(rBottom, rTop);
    if (maxR <= 0 || height === null) return () => false;
    const axis = parseAxisVector(params.axis);
    const halfH = height * 0.5;
    const eps = Math.max(maxR, height) * REL_TOLERANCE + ABS_TOLERANCE;
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
      if (Math.abs(axial) > halfH + eps) return false;
      const t = Math.max(0, Math.min(1, (axial + halfH) / height));
      const rAtAxial = rBottom + t * (rTop - rBottom) + eps;
      const rx = dx - axial * axis[0];
      const ry = dy - axial * axis[1];
      const rz = dz - axial * axis[2];
      return rx * rx + ry * ry + rz * rz <= rAtAxial * rAtAxial;
    };
  }

  if (rawKind === "torus") {
    const majorR = asPositiveNumber(params.major_radius ?? params.radius);
    const minorR = asPositiveNumber(params.minor_radius ?? params.tube_radius);
    if (majorR === null || minorR === null) return () => false;
    const axis = parseAxisVector(params.axis);
    const eps = (majorR + minorR) * REL_TOLERANCE + ABS_TOLERANCE;
    const minorSq = (minorR + eps) * (minorR + eps);
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
      const rx = dx - axial * axis[0];
      const ry = dy - axial * axis[1];
      const rz = dz - axial * axis[2];
      const radial = Math.hypot(rx, ry, rz);
      const dr = radial - majorR;
      return dr * dr + axial * axial <= minorSq;
    };
  }

  if (
    rawKind === "polygonprism" ||
    rawKind === "polygon_prism" ||
    rawKind === "polygonextrusion" ||
    rawKind === "extrudedpolygon" ||
    rawKind === "extruded_polygon" ||
    rawKind === "polygon"
  ) {
    const rawVerts = Array.isArray(params.vertices_xy)
      ? params.vertices_xy
      : Array.isArray(params.vertices)
        ? params.vertices
        : Array.isArray(params.points)
          ? params.points
          : null;
    if (!rawVerts || rawVerts.length < 3) return () => false;
    const vertices: [number, number][] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pair of rawVerts) {
      let x: number | null = null;
      let y: number | null = null;
      if (Array.isArray(pair) && pair.length >= 2) {
        x = asNumber(pair[0]);
        y = asNumber(pair[1]);
      } else {
        const pRec = asRecord(pair);
        if (pRec) {
          x = asNumber(pRec.x);
          y = asNumber(pRec.y);
        }
      }
      if (x === null || y === null) continue;
      vertices.push([x, y]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (vertices.length < 3) return () => false;
    const height = asPositiveNumber(params.thickness ?? params.height) ?? 10e-9;
    const halfH = height * 0.5;
    const maxDim = Math.max(maxX - minX, maxY - minY, height, 1e-12);
    const eps = maxDim * REL_TOLERANCE + ABS_TOLERANCE;
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      if (Math.abs(dz) > halfH + eps) return false;
      if (dx < minX - eps || dx > maxX + eps || dy < minY - eps || dy > maxY + eps) {
        return false;
      }
      return pointInPolygon2D(dx, dy, vertices, eps);
    };
  }

  if (rawKind === "ellipse") {
    const rx = asPositiveNumber(params.rx ?? params.radius_x ?? params.semi_major);
    const ry = asPositiveNumber(params.ry ?? params.radius_y ?? params.semi_minor);
    const height = asPositiveNumber(params.height ?? params.thickness) ?? 10e-9;
    if (rx === null || ry === null) return () => false;
    const halfH = height * 0.5;
    const eps = Math.max(rx, ry, height) * REL_TOLERANCE + ABS_TOLERANCE;
    const limit = 1 + REL_TOLERANCE * 2;
    return (point) => {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      if (Math.abs(dz) > halfH + eps) return false;
      const nx = dx / rx;
      const ny = dy / ry;
      return nx * nx + ny * ny <= limit;
    };
  }

  // Fallback to bounding box for unknown primitive types
  const fallbackBounds = computeSceneGeometryBoundsMeters(rec);
  if (fallbackBounds) {
    const eps = Math.max(...fallbackBounds.size, 1e-12) * REL_TOLERANCE + ABS_TOLERANCE;
    return (point) => pointInBounds(point, fallbackBounds, eps);
  }
  return () => false;
}

/**
 * Compiles a fast reusable containment predicate for any canonical `SceneGeometry`
 * (optionally wrapped in an object-level `Transform3D` applied via exact $M^{-1}$).
 */
export function compileSceneGeometryContainment(
  geometry: Record<string, unknown>,
  transform?: unknown,
): SceneGeometryContainmentTester {
  const localTester = compileNode(geometry, 0);
  return transform ? wrapWithInverseTransform(localTester, transform) : localTester;
}

/**
 * Pure point-in-CSG containment test in the geometry's local coordinate frame (meters).
 * Supports `Box`, `Cylinder`, `Tube`, `Sphere`, `Ellipsoid`, `Cone`, `Torus`,
 * `PolygonPrism`, `Ellipse`, `Translate`/`Transform` (via $M^{-1}$), `SlicePlane`,
 * `Union`, `Difference`, `Intersection`, `Xor`, and `Array3D`.
 */
export function isPointInsideSceneGeometry(
  pointLocalMeters: readonly [number, number, number],
  geometry: Record<string, unknown>,
): boolean {
  return compileNode(geometry, 0)(pointLocalMeters);
}

/**
 * Point-in-CSG containment test in world coordinates (meters), inverting the optional
 * object `Transform3D` before evaluating the geometry tree.
 */
export function isWorldPointInsideSceneGeometry(
  pointWorldMeters: readonly [number, number, number],
  geometry: Record<string, unknown>,
  transform?: unknown,
): boolean {
  return compileSceneGeometryContainment(geometry, transform)(pointWorldMeters);
}
