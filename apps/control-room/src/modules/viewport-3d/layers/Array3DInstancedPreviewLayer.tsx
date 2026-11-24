"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Euler,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";

import {
  computeArray3DInstanceTransforms,
  MAX_ARRAY_INSTANCES_FEM_OCC,
  parseArray3DGeometry,
  type Array3DAxes,
  type Vec3Tuple,
} from "@/kernel/authoring/array3dModel";
import { parseCompositeGeometry } from "@/kernel/authoring/compositeGeometryModel";
import { computeSceneGeometryBoundsMeters } from "@/shared/domain/geometry/sceneGeometryBounds";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
  Viewport3DPrimitiveTransform,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  composeTransformMatrix4,
  createScenePreviewBufferGeometry,
} from "./previewGeometryBuilder";

export { composeTransformMatrix4 };
export const createPreviewChildBufferGeometry = createScenePreviewBufferGeometry;

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

function childSizeFromGeometry(
  geometry: Record<string, unknown>,
  childTransform?: Record<string, unknown>,
): Vec3Tuple {
  const computed = computeSceneGeometryBoundsMeters(geometry, childTransform);
  if (computed) {
    return [
      Math.max(computed.size[0], 1e-12),
      Math.max(computed.size[1], 1e-12),
      Math.max(computed.size[2], 1e-12),
    ];
  }
  return [50e-9, 50e-9, 10e-9];
}

export function extractArray3DPreviewDescriptors(
  objects: readonly Viewport3DPrimitiveObject[],
): Array3DPreviewDescriptor[] {
  const descriptors: Array3DPreviewDescriptor[] = [];

  for (const obj of objects) {
    if (!obj.rawGeometry) continue;
    const rootTransform: Viewport3DPrimitiveTransform | undefined =
      obj.transform ??
      (obj.translation ? { translation: obj.translation } : undefined);
    const direct = parseArray3DGeometry(obj.rawGeometry);
    if (direct) {
      descriptors.push({
        axes: direct.axes,
        childGeometry: direct.child,
        childKind: String(direct.child.geometry_kind ?? direct.child.kind ?? "Box"),
        childSize: childSizeFromGeometry(direct.child, direct.childTransform),
        ...(direct.childTransform ? { childTransform: direct.childTransform } : {}),
        isCutter: false,
        key: `${obj.geometryKey}:array3d`,
        objectId: obj.objectId,
        rootTransform,
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
        childSize: childSizeFromGeometry(nestedArray.child, nestedArray.childTransform),
        ...(nestedArray.childTransform ? { childTransform: nestedArray.childTransform } : {}),
        isCutter: operand.role === "subtract" || operand.role === "intersect",
        key: `${obj.geometryKey}:array3d:${operand.operandId}`,
        objectId: obj.objectId,
        operandId: operand.operandId,
        ...(operand.transform ? { operandTransform: operand.transform } : {}),
        rootTransform,
      });
    }
  }

  return descriptors;
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
        opacity={descriptor.isCutter ? 0.22 : 0.9}
        roughness={0.55}
        transparent={descriptor.isCutter}
      />
    </instancedMesh>
  );
}

export function Array3DInstancedPreviewLayer({
  colors,
  primitiveModel,
  suppressedSolidObjectIds,
  tracker,
}: {
  colors: Viewport3DColors;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  suppressedSolidObjectIds?: ReadonlySet<string>;
  tracker: Viewport3DResourceTracker;
}) {
  const descriptors = useMemo(
    () =>
      extractArray3DPreviewDescriptors(primitiveModel?.objects ?? []).filter(
        (descriptor) =>
          descriptor.isCutter ||
          !(suppressedSolidObjectIds?.has(descriptor.objectId) ?? false),
      ),
    [primitiveModel?.objects, suppressedSolidObjectIds],
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
