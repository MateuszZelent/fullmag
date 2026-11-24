import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

import {
  computeArray3DInstanceTransforms,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";
import { parseCompositeGeometry } from "@/kernel/authoring/compositeGeometryModel";
import { computeSceneGeometryBoundsMeters } from "@/shared/domain/geometry/sceneGeometryBounds";

import {
  cardinalAxisIndex,
  planeAxesForCardinalAxis,
  type Viewport3DBoxCylinderDifferencePreview,
  type Viewport3DCylinderCylinderDifferencePreview,
  type Viewport3DPrimitiveTransform,
} from "../viewport3dPrimitiveModel";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vec3FromUnknown(
  raw: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (
    Array.isArray(raw) &&
    raw.length >= 3 &&
    raw.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return [raw[0] as number, raw[1] as number, raw[2] as number];
  }
  return fallback;
}

function quatFromUnknown(
  raw: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (
    Array.isArray(raw) &&
    raw.length >= 4 &&
    raw.slice(0, 4).every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return [raw[0] as number, raw[1] as number, raw[2] as number, raw[3] as number];
  }
  return fallback;
}

/**
 * Compose exact M = T(t + p) * R * S * T(-p) matrix from either a typed
 * `Viewport3DPrimitiveTransform` or a raw SceneDocument `Transform3D` record.
 */
export function composeTransformMatrix4(
  transform: Viewport3DPrimitiveTransform | Record<string, unknown> | undefined | null,
): Matrix4 {
  const mat = new Matrix4();
  if (!transform) return mat;
  const rec = transform as Record<string, unknown>;
  const translation = vec3FromUnknown(rec.translation ?? rec.offset ?? rec.delta, [0, 0, 0]);
  const rotationQuat = quatFromUnknown(
    rec.rotationQuat ?? rec.rotation_quat,
    [0, 0, 0, 1],
  );
  const scaleArr = vec3FromUnknown(rec.scale, [1, 1, 1]);
  const pivotArr = vec3FromUnknown(rec.pivot, [0, 0, 0]);

  const pos = new Vector3(...translation);
  const quat = new Quaternion(...rotationQuat);
  if (quat.lengthSq() > 1e-24) {
    quat.normalize();
  } else {
    quat.identity();
  }
  const scale = new Vector3(...scaleArr);
  if (pivotArr.some((v) => Math.abs(v) > 1e-15)) {
    const p = new Vector3(...pivotArr);
    const mToPivot = new Matrix4().makeTranslation(-p.x, -p.y, -p.z);
    const mRS = new Matrix4().compose(new Vector3(0, 0, 0), quat, scale);
    const mFromPivot = new Matrix4().makeTranslation(pos.x + p.x, pos.y + p.y, pos.z + p.z);
    return mat.multiplyMatrices(mFromPivot, mRS).multiply(mToPivot);
  }
  return mat.compose(pos, quat, scale);
}

function axisVectorFromParam(raw: unknown): Vector3 {
  if (raw === "x" || raw === "X") return new Vector3(1, 0, 0);
  if (raw === "y" || raw === "Y") return new Vector3(0, 1, 0);
  if (raw === "z" || raw === "Z") return new Vector3(0, 0, 1);
  const tuple = vec3FromUnknown(raw, [0, 0, 1]);
  const axis = new Vector3(tuple[0], tuple[1], tuple[2]);
  if (axis.lengthSq() > 1e-24) {
    axis.normalize();
  } else {
    axis.set(0, 0, 1);
  }
  return axis;
}

function alignYUpGeometryToAxis(geometry: BufferGeometry, axis: Vector3): void {
  const up = new Vector3(0, 1, 0);
  const orientation = new Quaternion();
  if (axis.dot(up) < -0.999999) {
    orientation.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  } else {
    orientation.setFromUnitVectors(up, axis);
  }
  geometry.applyQuaternion(orientation);
}

function alignZUpGeometryToAxis(geometry: BufferGeometry, axis: Vector3): void {
  const zUp = new Vector3(0, 0, 1);
  const orientation = new Quaternion();
  if (axis.dot(zUp) < -0.999999) {
    orientation.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  } else {
    orientation.setFromUnitVectors(zUp, axis);
  }
  geometry.applyQuaternion(orientation);
}

function remapExtrudedCardinalAxisGeometry(
  geometry: BufferGeometry,
  axisIndex: 0 | 1,
): void {
  const rotation = axisIndex === 0
    ? new Matrix4().set(
        0, 0, 1, 0,
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
      )
    : new Matrix4().set(
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
      );
  geometry.applyMatrix4(rotation);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export function createBoxCylinderDifferenceGeometry(
  preview: Viewport3DBoxCylinderDifferencePreview,
): BufferGeometry {
  const [x, y, z] = preview.boxSize;
  const axisIndex = cardinalAxisIndex(preview.cylinderAxis);
  if (axisIndex === null) {
    return new BoxGeometry(x, y, z);
  }

  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const depth = Math.max(preview.boxSize[axisIndex], 1e-12);
  const planeWidth = Math.max(preview.boxSize[planeAxes[0]], 1e-12);
  const planeHeight = Math.max(preview.boxSize[planeAxes[1]], 1e-12);
  const halfWidth = planeWidth / 2;
  const halfHeight = planeHeight / 2;
  const radius = Math.min(
    Math.max(preview.cylinderRadius, 1e-12),
    Math.max(Math.min(halfWidth, halfHeight) * 0.98, 1e-12),
  );
  const centerX = preview.cylinderCenter[planeAxes[0]];
  const centerY = preview.cylinderCenter[planeAxes[1]];
  const shape = new Shape();
  shape.moveTo(-halfWidth, -halfHeight);
  shape.lineTo(halfWidth, -halfHeight);
  shape.lineTo(halfWidth, halfHeight);
  shape.lineTo(-halfWidth, halfHeight);
  shape.lineTo(-halfWidth, -halfHeight);

  const hole = new Path();
  hole.absarc(centerX, centerY, radius, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geometry = new ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: 64,
    depth,
  });
  geometry.translate(0, 0, -depth / 2);
  if (axisIndex !== 2) {
    remapExtrudedCardinalAxisGeometry(geometry, axisIndex);
  }
  return geometry;
}

export function createCylinderCylinderDifferenceGeometry(
  preview: Viewport3DCylinderCylinderDifferencePreview,
): BufferGeometry {
  const axisIndex = cardinalAxisIndex(preview.cylinderAxis);
  if (axisIndex === null) {
    const [x, y, z] = preview.boundsSize;
    return new BoxGeometry(x, y, z);
  }

  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const innerCenterX =
    preview.innerCenter[planeAxes[0]] - preview.outerCenter[planeAxes[0]];
  const innerCenterY =
    preview.innerCenter[planeAxes[1]] - preview.outerCenter[planeAxes[1]];
  const shape = new Shape();
  shape.absarc(0, 0, preview.outerRadius, 0, Math.PI * 2, false);
  const hole = new Path();
  hole.absarc(
    innerCenterX,
    innerCenterY,
    preview.innerRadius,
    0,
    Math.PI * 2,
    true,
  );
  shape.holes.push(hole);

  const geometry = new ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: 64,
    depth: preview.outerHeight,
  });
  geometry.translate(0, 0, -preview.outerHeight / 2);
  if (axisIndex !== 2) {
    remapExtrudedCardinalAxisGeometry(geometry, axisIndex);
  }
  return geometry;
}

/**
 * Merge multiple BufferGeometries into a single non-indexed BufferGeometry
 * containing `position` and `normal` attributes, disposing intermediate copies.
 */
export function mergeNormalizedBufferGeometries(
  geometries: readonly BufferGeometry[],
): BufferGeometry {
  if (geometries.length === 0) {
    return new BufferGeometry();
  }
  if (geometries.length === 1) {
    const single = geometries[0]!;
    if (!single.getAttribute("normal")) single.computeVertexNormals();
    single.computeBoundingBox();
    single.computeBoundingSphere();
    return single;
  }

  const normalized: BufferGeometry[] = [];
  let totalVertexCount = 0;

  for (const source of geometries) {
    const nonIndexed = source.index ? source.toNonIndexed() : source.clone();
    const posAttr = nonIndexed.getAttribute("position");
    if (!posAttr || posAttr.count === 0) {
      nonIndexed.dispose();
      continue;
    }
    if (!nonIndexed.getAttribute("normal")) {
      nonIndexed.computeVertexNormals();
    }
    totalVertexCount += posAttr.count;
    normalized.push(nonIndexed);
  }

  for (const source of geometries) {
    source.dispose();
  }

  if (totalVertexCount === 0) {
    for (const item of normalized) item.dispose();
    return new BufferGeometry();
  }

  const positions = new Float32Array(totalVertexCount * 3);
  const normals = new Float32Array(totalVertexCount * 3);
  let vertexOffset = 0;

  for (const item of normalized) {
    const pos = item.getAttribute("position");
    const norm = item.getAttribute("normal");
    for (let i = 0; i < pos.count; i += 1) {
      const dst = (vertexOffset + i) * 3;
      positions[dst] = pos.getX(i);
      positions[dst + 1] = pos.getY(i);
      positions[dst + 2] = pos.getZ(i);
      if (norm) {
        normals[dst] = norm.getX(i);
        normals[dst + 1] = norm.getY(i);
        normals[dst + 2] = norm.getZ(i);
      }
    }
    vertexOffset += pos.count;
    item.dispose();
  }

  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.setAttribute("normal", new BufferAttribute(normals, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

const MAX_ANALYTICAL_ARRAY_HOLES = 256;

interface AnalyticalHole2D {
  readonly boundingRadius: number;
  readonly cx: number;
  readonly cy: number;
  readonly kind: "circle" | "polygon";
  readonly points?: readonly [number, number][];
  readonly radius?: number;
  readonly uMax: number;
  readonly uMin: number;
  readonly vMax: number;
  readonly vMin: number;
}

function axisUnitVector(axisIndex: 0 | 1 | 2): Vector3 {
  if (axisIndex === 0) return new Vector3(1, 0, 0);
  if (axisIndex === 1) return new Vector3(0, 1, 0);
  return new Vector3(0, 0, 1);
}

function unwrapGeometryWithTransform(
  geometry: Record<string, unknown>,
  initialMatrix: Matrix4,
): { geometry: Record<string, unknown>; matrix: Matrix4 } {
  let current = geometry;
  const matrix = initialMatrix.clone();
  for (let depth = 0; depth < 8; depth += 1) {
    const kind = String(current.geometry_kind ?? current.kind ?? "").trim().toLowerCase();
    const params = asRecord(current.geometry_params) ?? asRecord(current.params) ?? {};
    if (kind === "translate" || kind === "transform") {
      const child = asRecord(params.child) ?? asRecord(params.base);
      if (!child) break;
      const tx = asRecord(params.transform) ?? params;
      matrix.multiply(composeTransformMatrix4(tx));
      current = child;
      continue;
    }
    break;
  }
  return { geometry: current, matrix };
}

function extractPrimitiveHole2D(
  rawGeometry: Record<string, unknown>,
  relMatrix: Matrix4,
  axisIndex: 0 | 1 | 2,
  planeAxes: readonly [0 | 1 | 2, 0 | 1 | 2],
): AnalyticalHole2D | null {
  const { geometry, matrix } = unwrapGeometryWithTransform(rawGeometry, relMatrix);
  const kind = String(geometry.geometry_kind ?? geometry.kind ?? "").trim().toLowerCase();
  const params = asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};
  const baseAxisVec = axisUnitVector(axisIndex);

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  matrix.decompose(pos, quat, scl);
  const absScale: [number, number, number] = [
    Math.abs(scl.x),
    Math.abs(scl.y),
    Math.abs(scl.z),
  ];

  if (kind === "cylinder" || kind === "disk") {
    const radius = num(params.radius, 0);
    const height = num(params.height ?? params.length ?? params.thickness, 0);
    if (radius <= 0 || height <= 0) return null;

    const cylAxis = axisVectorFromParam(params.axis).applyQuaternion(quat).normalize();
    if (Math.abs(cylAxis.dot(baseAxisVec)) < 0.999) return null;

    const sU = absScale[planeAxes[0]];
    const sV = absScale[planeAxes[1]];
    if (sU <= 0 || sV <= 0 || Math.abs(sU - sV) > Math.max(sU, sV) * 1e-5) {
      return null;
    }

    const effRadius = radius * sU;
    const localCenter = vec3FromUnknown(params.translation ?? params.center, [0, 0, 0]);
    const worldCenter = new Vector3(...localCenter).applyMatrix4(matrix);
    const cx = worldCenter.getComponent(planeAxes[0]);
    const cy = worldCenter.getComponent(planeAxes[1]);
    return {
      boundingRadius: effRadius,
      cx,
      cy,
      kind: "circle",
      radius: effRadius,
      uMax: cx + effRadius,
      uMin: cx - effRadius,
      vMax: cy + effRadius,
      vMin: cy - effRadius,
    };
  }

  if (kind === "box" || kind === "film" || kind === "cuboid") {
    const size = vec3FromUnknown(params.size ?? params.dimensions, [0, 0, 0]);
    if (!size.every((v) => v > 0)) return null;

    // Box extrusion axis must stay aligned with base axis (only in-plane rotation around axisIndex)
    const rotatedAxis = baseAxisVec.clone().applyQuaternion(quat).normalize();
    if (Math.abs(rotatedAxis.dot(baseAxisVec)) < 0.999) return null;

    const localCenter = vec3FromUnknown(params.translation ?? params.center, [0, 0, 0]);
    const hu = size[planeAxes[0]] * 0.5;
    const hv = size[planeAxes[1]] * 0.5;
    const localSigns: readonly [number, number][] = [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ];
    const pts: [number, number][] = localSigns.map(([su, sv]) => {
      const p = new Vector3(...localCenter);
      p.setComponent(planeAxes[0], p.getComponent(planeAxes[0]) + su * hu);
      p.setComponent(planeAxes[1], p.getComponent(planeAxes[1]) + sv * hv);
      p.applyMatrix4(matrix);
      return [p.getComponent(planeAxes[0]), p.getComponent(planeAxes[1])];
    });

    // Ensure clockwise (CW) winding for Three.js Shape.holes
    let signedArea2 = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % pts.length]!;
      signedArea2 += x1 * y2 - x2 * y1;
    }
    if (signedArea2 > 0) {
      pts.reverse();
    }

    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    let cx = 0;
    let cy = 0;
    for (const [u, v] of pts) {
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
      cx += u;
      cy += v;
    }
    cx /= pts.length;
    cy /= pts.length;
    const boundingRadius = Math.max(
      ...pts.map(([u, v]) => Math.hypot(u - cx, v - cy)),
    );
    return {
      boundingRadius,
      cx,
      cy,
      kind: "polygon",
      points: pts,
      uMax,
      uMin,
      vMax,
      vMin,
    };
  }

  return null;
}

function collectCutterHoles2D(
  cutterGeometry: Record<string, unknown>,
  relMatrix: Matrix4,
  axisIndex: 0 | 1 | 2,
  planeAxes: readonly [0 | 1 | 2, 0 | 1 | 2],
): AnalyticalHole2D[] {
  const { geometry, matrix } = unwrapGeometryWithTransform(cutterGeometry, relMatrix);
  const parsedArray = parseArray3DGeometry(geometry);
  if (parsedArray) {
    const childBounds = computeSceneGeometryBoundsMeters(
      parsedArray.child,
      parsedArray.childTransform,
    );
    const childSize: [number, number, number] = childBounds
      ? [...childBounds.size]
      : [50e-9, 50e-9, 10e-9];
    const instances = computeArray3DInstanceTransforms(
      parsedArray.axes,
      childSize,
      MAX_ANALYTICAL_ARRAY_HOLES,
    );
    const childMatrix = composeTransformMatrix4(parsedArray.childTransform);
    const deg2rad = Math.PI / 180;
    const holes: AnalyticalHole2D[] = [];
    for (const inst of instances) {
      const instMatrix = new Matrix4().compose(
        new Vector3(...inst.translation),
        new Quaternion().setFromEuler(
          new Euler(
            inst.rotationEulerDeg[0] * deg2rad,
            inst.rotationEulerDeg[1] * deg2rad,
            inst.rotationEulerDeg[2] * deg2rad,
            "XYZ",
          ),
        ),
        new Vector3(...inst.scale),
      );
      const fullMatrix = new Matrix4()
        .multiplyMatrices(matrix, instMatrix)
        .multiply(childMatrix);
      const hole = extractPrimitiveHole2D(
        parsedArray.child,
        fullMatrix,
        axisIndex,
        planeAxes,
      );
      if (hole) holes.push(hole);
    }
    return holes;
  }

  const single = extractPrimitiveHole2D(geometry, matrix, axisIndex, planeAxes);
  return single ? [single] : [];
}

function holeFitsInsideBase(
  hole: AnalyticalHole2D,
  baseContour:
    | { halfH: number; halfW: number; kind: "box" }
    | { kind: "cylinder"; radius: number },
): boolean {
  const margin = 0.985;
  if (baseContour.kind === "box") {
    return (
      hole.uMin > -baseContour.halfW * margin &&
      hole.uMax < baseContour.halfW * margin &&
      hole.vMin > -baseContour.halfH * margin &&
      hole.vMax < baseContour.halfH * margin
    );
  }
  return Math.hypot(hole.cx, hole.cy) + hole.boundingRadius < baseContour.radius * margin;
}

function holesOverlap(a: AnalyticalHole2D, b: AnalyticalHole2D): boolean {
  const eps = 1e-12;
  if (a.uMax + eps < b.uMin || b.uMax + eps < a.uMin || a.vMax + eps < b.vMin || b.vMax + eps < a.vMin) {
    return false;
  }
  if (a.kind === "circle" && b.kind === "circle") {
    return Math.hypot(a.cx - b.cx, a.cy - b.cy) < (a.radius ?? 0) + (b.radius ?? 0) + eps;
  }
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.boundingRadius + b.boundingRadius + eps;
}

function appendHoleToShape(shape: Shape, hole: AnalyticalHole2D): void {
  const path = new Path();
  if (hole.kind === "circle" && hole.radius && hole.radius > 0) {
    path.absarc(hole.cx, hole.cy, hole.radius, 0, Math.PI * 2, true);
    shape.holes.push(path);
    return;
  }
  if (hole.kind === "polygon" && hole.points && hole.points.length >= 3) {
    const first = hole.points[0]!;
    path.moveTo(first[0], first[1]);
    for (let i = 1; i < hole.points.length; i += 1) {
      const pt = hole.points[i]!;
      path.lineTo(pt[0], pt[1]);
    }
    path.closePath();
    shape.holes.push(path);
  }
}

function tryAnalyticalDifferenceGeometry(
  operands: ReturnType<typeof parseCompositeGeometry>["operands"],
): BufferGeometry | null {
  const enabled = operands.filter((op) => op.enabled);
  if (enabled.length < 2) return null;
  const baseOp = enabled[0]!;
  const baseRootMatrix = composeTransformMatrix4(baseOp.transform);
  const { geometry: baseGeom, matrix: baseMatrix } = unwrapGeometryWithTransform(
    baseOp.geometry,
    baseRootMatrix,
  );
  const baseKind = String(baseGeom.geometry_kind ?? baseGeom.kind ?? "").trim().toLowerCase();
  const baseParams = asRecord(baseGeom.geometry_params) ?? asRecord(baseGeom.params) ?? {};

  let axisIndex: 0 | 1 | 2 = 2;
  let depth = 0;
  let baseContour:
    | { halfH: number; halfW: number; kind: "box" }
    | { kind: "cylinder"; radius: number };

  if (baseKind === "box" || baseKind === "film" || baseKind === "cuboid") {
    const boxSize = vec3FromUnknown(baseParams.size ?? baseParams.dimensions, [0, 0, 0]);
    if (!boxSize.every((v) => v > 0)) return null;
    // Pick the first cutter's cardinal axis when cutting a Box (default Z)
    const firstTool = enabled[1]!;
    const firstToolParams =
      asRecord(firstTool.geometry.geometry_params) ?? asRecord(firstTool.geometry.params) ?? {};
    const parsedFirstArray = parseArray3DGeometry(firstTool.geometry);
    const axisSource = parsedFirstArray
      ? (asRecord(parsedFirstArray.child.geometry_params) ?? asRecord(parsedFirstArray.child.params))?.axis
      : firstToolParams.axis;
    axisIndex = cardinalAxisIndex(vec3FromUnknown(axisSource, [0, 0, 1])) ?? 2;
    const planeAxes = planeAxesForCardinalAxis(axisIndex);
    depth = boxSize[axisIndex];
    baseContour = {
      halfH: boxSize[planeAxes[1]] * 0.5,
      halfW: boxSize[planeAxes[0]] * 0.5,
      kind: "box",
    };
  } else if (baseKind === "cylinder" || baseKind === "disk") {
    const outerRadius = num(baseParams.radius, 0);
    const outerHeight = num(baseParams.height ?? baseParams.length ?? baseParams.thickness, 0);
    if (outerRadius <= 0 || outerHeight <= 0) return null;
    const baseAxisIdx = cardinalAxisIndex(vec3FromUnknown(baseParams.axis, [0, 0, 1]));
    if (baseAxisIdx === null) return null;
    axisIndex = baseAxisIdx;
    depth = outerHeight;
    baseContour = { kind: "cylinder", radius: outerRadius };
  } else {
    return null;
  }

  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const invBaseMatrix = baseMatrix.clone().invert();
  const acceptedHoles: AnalyticalHole2D[] = [];

  for (let i = 1; i < enabled.length; i += 1) {
    const toolOp = enabled[i]!;
    const toolMatrix = composeTransformMatrix4(toolOp.transform);
    const relMatrix = new Matrix4().multiplyMatrices(invBaseMatrix, toolMatrix);
    const candidateHoles = collectCutterHoles2D(
      toolOp.geometry,
      relMatrix,
      axisIndex,
      planeAxes,
    );
    for (const hole of candidateHoles) {
      if (!holeFitsInsideBase(hole, baseContour)) continue;
      if (acceptedHoles.some((existing) => holesOverlap(existing, hole))) continue;
      acceptedHoles.push(hole);
      if (acceptedHoles.length >= MAX_ANALYTICAL_ARRAY_HOLES) break;
    }
    if (acceptedHoles.length >= MAX_ANALYTICAL_ARRAY_HOLES) break;
  }

  if (acceptedHoles.length === 0) return null;

  const shape = new Shape();
  if (baseContour.kind === "box") {
    const { halfW, halfH } = baseContour;
    shape.moveTo(-halfW, -halfH);
    shape.lineTo(halfW, -halfH);
    shape.lineTo(halfW, halfH);
    shape.lineTo(-halfW, halfH);
    shape.closePath();
  } else {
    shape.absarc(0, 0, baseContour.radius, 0, Math.PI * 2, false);
  }

  for (const hole of acceptedHoles) {
    appendHoleToShape(shape, hole);
  }

  const geom = new ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: acceptedHoles.length > 8 ? 24 : 48,
    depth: Math.max(depth, 1e-12),
  });
  geom.translate(0, 0, -Math.max(depth, 1e-12) * 0.5);
  if (axisIndex !== 2) {
    remapExtrudedCardinalAxisGeometry(geom, axisIndex);
  }
  geom.applyMatrix4(baseMatrix);
  geom.userData.analyticalHoleCount = acceptedHoles.length;
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Recursively constructs a preview BufferGeometry for any primitive or composite
 * `SceneGeometry` (`Box`, `Cylinder`, `Sphere`, `Ellipsoid`, `Cone`, `Tube`, `Torus`,
 * `PolygonPrism`, `Translate`/`Transform`, `SlicePlane`, `Union`/`Difference`/`Intersection`/`Xor`).
 */
export function createScenePreviewBufferGeometry(
  geometry: Record<string, unknown>,
  depth = 0,
): BufferGeometry {
  if (depth > 12) {
    return new BoxGeometry(50e-9, 50e-9, 10e-9);
  }

  const kind = String(geometry.geometry_kind ?? geometry.kind ?? "Box").trim().toLowerCase();
  const params = asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};

  if (kind === "translate" || kind === "transform") {
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (child) {
      const childGeom = createScenePreviewBufferGeometry(child, depth + 1);
      const tx = asRecord(params.transform) ?? params;
      childGeom.applyMatrix4(composeTransformMatrix4(tx));
      childGeom.computeBoundingBox();
      childGeom.computeBoundingSphere();
      return childGeom;
    }
  }

  if (kind === "sliceplane" || kind === "slice_plane") {
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (child) {
      return createScenePreviewBufferGeometry(child, depth + 1);
    }
  }

  if (kind === "array3d" || kind === "array_3d") {
    const parsed = parseArray3DGeometry(geometry);
    if (parsed) {
      const childGeom = createScenePreviewBufferGeometry(parsed.child, depth + 1);
      if (parsed.childTransform) {
        childGeom.applyMatrix4(composeTransformMatrix4(parsed.childTransform));
      }
      return childGeom;
    }
  }

  const composite = parseCompositeGeometry(geometry);
  if (composite.op && composite.op !== "array" && composite.operands.length > 0) {
    const enabled = composite.operands.filter((op) => op.enabled);
    if (enabled.length === 0) {
      return new BufferGeometry();
    }

    if (composite.op === "subtract") {
      const analytical = tryAnalyticalDifferenceGeometry(composite.operands);
      if (analytical) return analytical;
      const baseOp = enabled[0]!;
      const baseGeom = createScenePreviewBufferGeometry(baseOp.geometry, depth + 1);
      if (baseOp.transform) {
        baseGeom.applyMatrix4(composeTransformMatrix4(baseOp.transform));
      }
      baseGeom.computeBoundingBox();
      baseGeom.computeBoundingSphere();
      return baseGeom;
    }

    if (composite.op === "intersect") {
      const baseOp = enabled[0]!;
      const baseGeom = createScenePreviewBufferGeometry(baseOp.geometry, depth + 1);
      if (baseOp.transform) {
        baseGeom.applyMatrix4(composeTransformMatrix4(baseOp.transform));
      }
      baseGeom.computeBoundingBox();
      baseGeom.computeBoundingSphere();
      return baseGeom;
    }

    // Union / Xor: merge all enabled non-Array3D operands with their exact local transforms
    const parts: BufferGeometry[] = [];
    for (const op of enabled) {
      if (parseArray3DGeometry(op.geometry)) {
        // Array3DInstancedPreviewLayer renders nested Array3D operands with InstancedMesh
        continue;
      }
      const partGeom = createScenePreviewBufferGeometry(op.geometry, depth + 1);
      if (op.transform) {
        partGeom.applyMatrix4(composeTransformMatrix4(op.transform));
      }
      parts.push(partGeom);
    }
    if (parts.length > 0) {
      return mergeNormalizedBufferGeometries(parts);
    }
    return new BufferGeometry();
  }

  if (kind === "sphere") {
    return new SphereGeometry(Math.max(num(params.radius, 25e-9), 1e-12), 24, 16);
  }
  if (kind === "ellipsoid") {
    const radii = vec3FromUnknown(params.radii, [0, 0, 0]);
    const size = vec3FromUnknown(params.size ?? params.dimensions, [50e-9, 50e-9, 20e-9]);
    const rx = Math.max(radii[0] > 0 ? radii[0] : size[0] * 0.5, 1e-12);
    const ry = Math.max(radii[1] > 0 ? radii[1] : size[1] * 0.5, 1e-12);
    const rz = Math.max(radii[2] > 0 ? radii[2] : size[2] * 0.5, 1e-12);
    const geom = new SphereGeometry(1, 24, 16);
    geom.scale(rx, ry, rz);
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }
  if (kind === "cylinder" || kind === "disk") {
    const r = Math.max(num(params.radius, 20e-9), 1e-12);
    const h = Math.max(num(params.height ?? params.length ?? params.thickness, 20e-9), 1e-12);
    const geom = new CylinderGeometry(r, r, h, 28);
    alignYUpGeometryToAxis(geom, axisVectorFromParam(params.axis));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }
  if (kind === "cone" || kind === "frustum") {
    const rb = Math.max(num(params.radius_bottom ?? params.bottom_radius, 25e-9), 0);
    const rt = Math.max(num(params.radius_top ?? params.top_radius, 10e-9), 0);
    const h = Math.max(num(params.height ?? params.length, 25e-9), 1e-12);
    const geom = new CylinderGeometry(rt, rb, h, 24);
    alignYUpGeometryToAxis(geom, axisVectorFromParam(params.axis));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }
  if (kind === "tube" || kind === "ring" || kind === "hollowcylinder") {
    const outerR = Math.max(num(params.outer_radius ?? params.radius, 50e-9), 1e-12);
    const innerR = Math.min(Math.max(num(params.inner_radius, outerR * 0.4), 1e-12), outerR * 0.98);
    const h = Math.max(num(params.height ?? params.length ?? params.thickness, 20e-9), 1e-12);
    const shape = new Shape();
    shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
    const hole = new Path();
    hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geom = new ExtrudeGeometry(shape, { bevelEnabled: false, curveSegments: 40, depth: h });
    geom.translate(0, 0, -h * 0.5);
    alignZUpGeometryToAxis(geom, axisVectorFromParam(params.axis));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }
  if (kind === "torus") {
    const major = Math.max(num(params.major_radius, 40e-9), 1e-12);
    const minor = Math.max(num(params.minor_radius, 10e-9), 1e-12);
    const geom = new TorusGeometry(major, minor, 16, 32);
    alignZUpGeometryToAxis(geom, axisVectorFromParam(params.axis));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }
  if (
    kind === "polygonprism" ||
    kind === "polygon_prism" ||
    kind === "polygonextrusion" ||
    kind === "extrudedpolygon" ||
    kind === "polygon"
  ) {
    const rawVerts = Array.isArray(params.vertices_xy)
      ? params.vertices_xy
      : Array.isArray(params.vertices)
        ? params.vertices
        : null;
    const h = Math.max(num(params.thickness ?? params.height, 10e-9), 1e-12);
    if (rawVerts && rawVerts.length >= 3) {
      const shape = new Shape();
      let started = false;
      for (const pair of rawVerts) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const vx = num(pair[0], 0);
        const vy = num(pair[1], 0);
        if (!started) {
          shape.moveTo(vx, vy);
          started = true;
        } else {
          shape.lineTo(vx, vy);
        }
      }
      if (started) {
        shape.closePath();
        const geom = new ExtrudeGeometry(shape, { bevelEnabled: false, depth: h });
        geom.translate(0, 0, -h * 0.5);
        geom.computeBoundingBox();
        geom.computeBoundingSphere();
        return geom;
      }
    }
  }

  const computed = computeSceneGeometryBoundsMeters(geometry);
  if (computed) {
    const geom = new BoxGeometry(
      Math.max(computed.size[0], 1e-12),
      Math.max(computed.size[1], 1e-12),
      Math.max(computed.size[2], 1e-12),
    );
    if (computed.center.some((v) => Math.abs(v) > 1e-15)) {
      geom.translate(computed.center[0], computed.center[1], computed.center[2]);
    }
    return geom;
  }

  return new BoxGeometry(50e-9, 50e-9, 10e-9);
}
