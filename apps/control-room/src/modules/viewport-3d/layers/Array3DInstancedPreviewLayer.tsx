"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

import {
  computeArray3DInstanceTransforms,
  MAX_ARRAY_INSTANCES_FEM_OCC,
  parseArray3DGeometry,
  type Array3DAxes,
  type Vec3Tuple,
} from "@/kernel/authoring/array3dModel";
import { parseCompositeGeometry } from "@/modules/explorer/builders/geometryTreeExplorerNodes";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
  Viewport3DPrimitiveTransform,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";

export interface Array3DPreviewDescriptor {
  axes: Array3DAxes;
  childGeometry: Record<string, unknown>;
  childKind: string;
  childSize: Vec3Tuple;
  childTransform?: Record<string, unknown>;
  isCutter: boolean;
  key: string;
  objectId: string;
  operandId?: string;
  operandTransform?: Record<string, unknown>;
  rootTransform?: Viewport3DPrimitiveTransform;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function childSizeFromGeometry(geometry: Record<string, unknown>): Vec3Tuple {
  const kind = String(geometry.geometry_kind ?? geometry.kind ?? "Box").toLowerCase();
  const params = asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};
  if (kind === "box") {
    const size = Array.isArray(params.size) ? params.size : [];
    return [num(size[0], 50e-9), num(size[1], 50e-9), num(size[2], 10e-9)];
  }
  if (kind === "sphere") {
    const d = num(params.radius, 25e-9) * 2;
    return [d, d, d];
  }
  if (kind === "cylinder" || kind === "cone") {
    const r = Math.max(
      num(params.radius, 0),
      num(params.radius_bottom, 0),
      num(params.radius_top, 0),
      20e-9,
    );
    const h = num(params.height ?? params.length, 20e-9);
    return [2 * r, 2 * r, h];
  }
  if (kind === "torus") {
    const major = num(params.major_radius, 40e-9);
    const minor = num(params.minor_radius, 10e-9);
    return [2 * (major + minor), 2 * (major + minor), 2 * minor];
  }
  if (kind === "ellipsoid") {
    const radii = Array.isArray(params.radii) ? params.radii : [];
    return [num(radii[0], 25e-9) * 2, num(radii[1], 25e-9) * 2, num(radii[2], 10e-9) * 2];
  }
  return [50e-9, 50e-9, 10e-9];
}

export function createPreviewChildBufferGeometry(
  geometry: Record<string, unknown>,
): BufferGeometry {
  const kind = String(geometry.geometry_kind ?? geometry.kind ?? "Box").toLowerCase();
  const params = asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};
  if (kind === "sphere") {
    return new SphereGeometry(Math.max(num(params.radius, 25e-9), 1e-12), 18, 14);
  }
  if (kind === "cylinder") {
    const r = Math.max(num(params.radius, 20e-9), 1e-12);
    const h = Math.max(num(params.height ?? params.length, 20e-9), 1e-12);
    const geom = new CylinderGeometry(r, r, h, 20);
    geom.rotateX(Math.PI / 2);
    return geom;
  }
  if (kind === "cone") {
    const rb = Math.max(num(params.radius_bottom ?? params.bottom_radius, 25e-9), 0);
    const rt = Math.max(num(params.radius_top ?? params.top_radius, 10e-9), 0);
    const h = Math.max(num(params.height, 25e-9), 1e-12);
    const geom = new CylinderGeometry(rt, rb, h, 20);
    geom.rotateX(Math.PI / 2);
    return geom;
  }
  if (kind === "torus") {
    const major = Math.max(num(params.major_radius, 40e-9), 1e-12);
    const minor = Math.max(num(params.minor_radius, 10e-9), 1e-12);
    return new TorusGeometry(major, minor, 12, 24);
  }
  const [sx, sy, sz] = childSizeFromGeometry(geometry);
  return new BoxGeometry(
    Math.max(sx, 1e-12),
    Math.max(sy, 1e-12),
    Math.max(sz, 1e-12),
  );
}

export function extractArray3DPreviewDescriptors(
  objects: readonly Viewport3DPrimitiveObject[],
): Array3DPreviewDescriptor[] {
  const descriptors: Array3DPreviewDescriptor[] = [];

  for (const obj of objects) {
    if (!obj.rawGeometry) continue;
    const direct = parseArray3DGeometry(obj.rawGeometry);
    if (direct) {
      descriptors.push({
        axes: direct.axes,
        childGeometry: direct.child,
        childKind: String(direct.child.geometry_kind ?? direct.child.kind ?? "Box"),
        childSize: childSizeFromGeometry(direct.child),
        ...(direct.childTransform ? { childTransform: direct.childTransform } : {}),
        isCutter: false,
        key: `${obj.geometryKey}:array3d`,
        objectId: obj.objectId,
        rootTransform: obj.transform,
      });
      continue;
    }

    const composite = parseCompositeGeometry(obj.rawGeometry);
    for (const operand of composite.operands) {
      if (!operand.enabled) continue;
      const nestedArray = parseArray3DGeometry(operand.geometry);
      if (!nestedArray) continue;
      descriptors.push({
        axes: nestedArray.axes,
        childGeometry: nestedArray.child,
        childKind: String(nestedArray.child.geometry_kind ?? nestedArray.child.kind ?? "Box"),
        childSize: childSizeFromGeometry(nestedArray.child),
        ...(nestedArray.childTransform ? { childTransform: nestedArray.childTransform } : {}),
        isCutter: operand.role === "subtract" || operand.role === "intersect",
        key: `${obj.geometryKey}:array3d:${operand.operandId}`,
        objectId: obj.objectId,
        operandId: operand.operandId,
        ...(operand.transform ? { operandTransform: operand.transform } : {}),
        rootTransform: obj.transform,
      });
    }
  }

  return descriptors;
}

function vec3FromUnknown(raw: unknown, fallback: Vec3Tuple): Vec3Tuple {
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
  const translation = vec3FromUnknown(rec.translation, [0, 0, 0]);
  const rotationQuat = quatFromUnknown(
    rec.rotationQuat ?? rec.rotation_quat,
    [0, 0, 0, 1],
  );
  const scaleArr = vec3FromUnknown(rec.scale, [1, 1, 1]);
  const pivotArr = vec3FromUnknown(rec.pivot, [0, 0, 0]);

  const pos = new Vector3(...translation);
  const quat = new Quaternion(...rotationQuat);
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

/**
 * Compute world instance matrices M_root * M_operand * M_{kx,ky,kz} * M_child
 * for single-draw-call THREE.InstancedMesh rendering.
 */
export function buildArray3DInstanceMatrices(
  descriptor: Array3DPreviewDescriptor,
  maxInstances = MAX_ARRAY_INSTANCES_FEM_OCC,
): Matrix4[] {
  const rootMatrix = composeTransformMatrix4(descriptor.rootTransform);
  const operandMatrix = composeTransformMatrix4(descriptor.operandTransform);
  const childMatrix = composeTransformMatrix4(descriptor.childTransform);
  const prefixMatrix = new Matrix4().multiplyMatrices(rootMatrix, operandMatrix);
  const instances = computeArray3DInstanceTransforms(
    descriptor.axes,
    descriptor.childSize,
    maxInstances,
  );
  const deg2rad = Math.PI / 180;
  return instances.map((inst) => {
    const localPos = new Vector3(...inst.translation);
    const localQuat = new Quaternion().setFromEuler(
      new Euler(
        inst.rotationEulerDeg[0] * deg2rad,
        inst.rotationEulerDeg[1] * deg2rad,
        inst.rotationEulerDeg[2] * deg2rad,
        "XYZ",
      ),
    );
    const localScale = new Vector3(...inst.scale);
    const instanceMatrix = new Matrix4().compose(localPos, localQuat, localScale);
    return new Matrix4()
      .multiplyMatrices(prefixMatrix, instanceMatrix)
      .multiply(childMatrix);
  });
}

function Array3DInstancedItem({
  colors,
  descriptor,
  tracker,
}: {
  colors: Viewport3DColors;
  descriptor: Array3DPreviewDescriptor;
  tracker: Viewport3DResourceTracker;
}) {
  const meshRef = useRef<InstancedMesh | null>(null);
  const invalidate = useBatchedInvalidate();
  const geometry = useMemo(() => {
    const next = createPreviewChildBufferGeometry(descriptor.childGeometry);
    return tracker.track("geometry", next);
  }, [descriptor.childGeometry, tracker]);
  const matrices = useMemo(
    () => buildArray3DInstanceMatrices(descriptor),
    [descriptor],
  );

  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < matrices.length; i += 1) {
      mesh.setMatrixAt(i, matrices[i]!);
    }
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [invalidate, matrices]);

  if (matrices.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, matrices.length]}
      name={`array3d-instanced:${descriptor.objectId}`}
      userData={{
        array3d: true,
        instanceCount: matrices.length,
        isCutter: descriptor.isCutter,
        objectId: descriptor.objectId,
        operandId: descriptor.operandId,
      }}
    >
      <meshStandardMaterial
        color={
          descriptor.isCutter
            ? (colors.antenna ?? colors.danger ?? colors.accent)
            : colors.accent
        }
        depthWrite={!descriptor.isCutter}
        opacity={descriptor.isCutter ? 0.18 : 0.42}
        roughness={0.55}
        transparent
      />
    </instancedMesh>
  );
}

export function Array3DInstancedPreviewLayer({
  colors,
  primitiveModel,
  tracker,
}: {
  colors: Viewport3DColors;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  tracker: Viewport3DResourceTracker;
}) {
  const descriptors = useMemo(
    () => extractArray3DPreviewDescriptors(primitiveModel?.objects ?? []),
    [primitiveModel?.objects],
  );

  if (descriptors.length === 0) return null;

  return (
    <group name="array3d-instanced-preview-layer" userData={{ layer: "array3d-instanced-preview" }}>
      {descriptors.map((descriptor) => (
        <Array3DInstancedItem
          key={descriptor.key}
          colors={colors}
          descriptor={descriptor}
          tracker={tracker}
        />
      ))}
    </group>
  );
}
