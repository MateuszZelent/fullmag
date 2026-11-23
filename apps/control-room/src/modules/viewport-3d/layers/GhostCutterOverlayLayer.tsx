"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { EdgesGeometry, type LineSegments, Matrix4, Quaternion, Vector3 } from "three";

import {
  geometryGhostVisibilityStore,
  geometryOperandGhostKey,
} from "@/kernel/visualization/geometryGhostVisibilityStore";
import { parseCompositeGeometry } from "@/modules/explorer/builders/geometryTreeExplorerNodes";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  composeTransformMatrix4,
  createPreviewChildBufferGeometry,
} from "./Array3DInstancedPreviewLayer";

export interface GhostCutterDescriptor {
  geometry: Record<string, unknown>;
  key: string;
  label: string;
  objectId: string;
  operandId: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  role: "subtract" | "intersect";
  scale: [number, number, number];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Resolve ghost cutter descriptors for Subtract/Intersect operands that are
 * selected or have local ghost visibility toggled on via `geometryGhostVisibilityStore`.
 */
export function resolveGhostCutterDescriptors(
  objects: readonly Viewport3DPrimitiveObject[],
  selectedObjectId: string | null,
  selectedOperandId: string | null,
  ghostKeys: ReadonlySet<string>,
): GhostCutterDescriptor[] {
  const descriptors: GhostCutterDescriptor[] = [];

  for (const obj of objects) {
    if (!obj.rawGeometry) continue;
    const composite = parseCompositeGeometry(obj.rawGeometry);
    if (composite.operands.length === 0) continue;

    const rootTransform = obj.transform ?? {
      translation: obj.translation ?? [0, 0, 0],
    };
    const rootMatrix = composeTransformMatrix4(rootTransform);

    for (const operand of composite.operands) {
      if (operand.role !== "subtract" && operand.role !== "intersect") continue;
      const ghostKey = geometryOperandGhostKey(obj.objectId, operand.operandId);
      const isGhostToggled = ghostKeys.has(ghostKey);
      const isSelectedOperand =
        obj.objectId === selectedObjectId &&
        selectedOperandId !== null &&
        operand.operandId === selectedOperandId;
      if (!isGhostToggled && !isSelectedOperand) continue;

      const opTransform = asRecord(operand.transform);
      const operandMatrix = composeTransformMatrix4(opTransform);
      const worldMatrix = new Matrix4().multiplyMatrices(rootMatrix, operandMatrix);
      const worldPos = new Vector3();
      const worldQuat = new Quaternion();
      const worldScale = new Vector3();
      worldMatrix.decompose(worldPos, worldQuat, worldScale);

      descriptors.push({
        geometry: operand.geometry,
        key: `${obj.geometryKey}:ghost:${operand.operandId}`,
        label: operand.label,
        objectId: obj.objectId,
        operandId: operand.operandId,
        position: [worldPos.x, worldPos.y, worldPos.z],
        quaternion: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
        role: operand.role,
        scale: [worldScale.x, worldScale.y, worldScale.z],
      });
    }
  }

  return descriptors;
}

function GhostCutterMesh({
  colors,
  descriptor,
  tracker,
}: {
  colors: Viewport3DColors;
  descriptor: GhostCutterDescriptor;
  tracker: Viewport3DResourceTracker;
}) {
  const lineRef = useRef<LineSegments | null>(null);
  const invalidate = useBatchedInvalidate();

  const geometry = useMemo(() => {
    const next = createPreviewChildBufferGeometry(descriptor.geometry);
    return tracker.track("geometry", next);
  }, [descriptor.geometry, tracker]);

  const edgesGeometry = useMemo(() => {
    const next = new EdgesGeometry(geometry);
    return tracker.track("geometry", next);
  }, [geometry, tracker]);

  useEffect(
    () => () => {
      tracker.release("geometry", edgesGeometry);
      tracker.release("geometry", geometry);
    },
    [edgesGeometry, geometry, tracker],
  );

  useLayoutEffect(() => {
    lineRef.current?.computeLineDistances();
    invalidate();
  }, [edgesGeometry, invalidate]);

  const dashUnit = useMemo(() => {
    geometry.computeBoundingSphere();
    const radius = geometry.boundingSphere?.radius ?? 50e-9;
    return Math.max(radius * 0.12, 1e-12);
  }, [geometry]);

  return (
    <group
      name={`ghost-cutter:${descriptor.objectId}:${descriptor.operandId}`}
      position={descriptor.position}
      quaternion={descriptor.quaternion}
      scale={descriptor.scale}
      userData={{
        ghostCutter: true,
        objectId: descriptor.objectId,
        operandId: descriptor.operandId,
        role: descriptor.role,
      }}
    >
      <mesh geometry={geometry}>
        <meshBasicMaterial
          color={colors.antenna ?? colors.danger ?? colors.accent}
          depthWrite={false}
          opacity={0.16}
          transparent
        />
      </mesh>
      <lineSegments ref={lineRef} geometry={edgesGeometry}>
        <lineDashedMaterial
          color={colors.antenna ?? colors.danger ?? colors.accent}
          dashSize={dashUnit}
          depthWrite={false}
          gapSize={dashUnit * 0.65}
          opacity={0.85}
          transparent
        />
      </lineSegments>
    </group>
  );
}

export function GhostCutterOverlayLayer({
  colors,
  primitiveModel,
  selectedObjectId,
  selectedOperandId = null,
  tracker,
}: {
  colors: Viewport3DColors;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  selectedObjectId: string | null;
  selectedOperandId?: string | null;
  tracker: Viewport3DResourceTracker;
}) {
  const ghostKeys = useSyncExternalStore(
    geometryGhostVisibilityStore.subscribe,
    geometryGhostVisibilityStore.getSnapshot,
    geometryGhostVisibilityStore.getServerSnapshot,
  );

  const descriptors = useMemo(
    () =>
      resolveGhostCutterDescriptors(
        primitiveModel?.objects ?? [],
        selectedObjectId,
        selectedOperandId,
        ghostKeys,
      ),
    [ghostKeys, primitiveModel?.objects, selectedObjectId, selectedOperandId],
  );

  if (descriptors.length === 0) return null;

  return (
    <group name="ghost-cutter-overlay-layer" userData={{ layer: "ghost-cutter-overlay" }}>
      {descriptors.map((descriptor) => (
        <GhostCutterMesh
          key={descriptor.key}
          colors={colors}
          descriptor={descriptor}
          tracker={tracker}
        />
      ))}
    </group>
  );
}
