"use client";

/**
 * Geometry builder authoring layer rendered inside a shared R3F canvas.
 *
 * Responsibilities:
 * - render Universe + primitive proxies
 * - provide selection bridge (viewport -> builder store)
 * - apply move/rotate/scale gizmo deltas using transform transactions
 * - keep all physical<->scene conversion in one helper module
 */

import { useMemo, useCallback, useRef, useEffect } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";

import {
  dimensionlessScaleToScene,
  physicalPositionToScene,
  physicalLengthToScene,
  physicalScaleToScene,
  physicalQuatToScene,
  sceneDeltaToPhysical,
  sceneScaleToDimensionless,
  sceneQuatToPhysical,
  type QuatTuple,
  type Vec3Tuple,
} from "@/features/viewport-core/coordinates/physicalToScene";
import {
  TransformGizmoLayer,
  type TransformGizmoDelta,
  type TransformGizmoMode,
} from "@/components/preview/transform/TransformGizmoLayer";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { PlacementValidation, PrimitiveNode, Vec3 } from "../model/types";

// ── Geometry factories ────────────────────────────────────────

function boxGeometry(size: Vec3): THREE.BufferGeometry {
  const [sx, sy, sz] = physicalScaleToScene(size as Vec3Tuple);
  return new THREE.BoxGeometry(sx, sy, sz);
}

function cylinderGeometry(radius: number, height: number, axis: "x" | "y" | "z"): THREE.BufferGeometry {
  const sceneRadius = physicalLengthToScene(radius);
  const sceneHeight = physicalLengthToScene(height);
  const geo = new THREE.CylinderGeometry(sceneRadius, sceneRadius, sceneHeight, 32);
  // CylinderGeometry default axis is scene-Y (physical Z with swapYZ convention).
  if (axis === "x") {
    geo.rotateZ(Math.PI / 2);
  } else if (axis === "y") {
    geo.rotateX(Math.PI / 2);
  }
  return geo;
}

function sphereGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(physicalLengthToScene(radius), 32, 24);
}

function diskGeometry(radius: number, thickness: number, axis: "x" | "y" | "z"): THREE.BufferGeometry {
  const sceneRadius = physicalLengthToScene(radius);
  const sceneThickness = physicalLengthToScene(thickness);
  const geo = new THREE.CylinderGeometry(sceneRadius, sceneRadius, sceneThickness, 32);
  if (axis === "x") {
    geo.rotateZ(Math.PI / 2);
  } else if (axis === "y") {
    geo.rotateX(Math.PI / 2);
  }
  return geo;
}

function triangularPrismGeometry(
  base: number,
  triHeight: number,
  depth: number,
  axis: "x" | "y" | "z",
): THREE.BufferGeometry {
  const sceneBase = physicalLengthToScene(base);
  const sceneTriHeight = physicalLengthToScene(triHeight);
  const sceneDepth = physicalLengthToScene(depth);
  const shape = new THREE.Shape();
  shape.moveTo(-sceneBase / 2, 0);
  shape.lineTo(sceneBase / 2, 0);
  shape.lineTo(0, sceneTriHeight);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: sceneDepth, bevelEnabled: false });
  geo.translate(0, 0, -sceneDepth / 2);

  if (axis === "x") {
    geo.rotateY(Math.PI / 2);
  } else if (axis === "y") {
    geo.rotateX(-Math.PI / 2);
  }
  return geo;
}

function geometryForPrimitive(node: PrimitiveNode): THREE.BufferGeometry {
  switch (node.params.kind) {
    case "box":
      return boxGeometry(node.params.data.size);
    case "cylinder":
      return cylinderGeometry(
        node.params.data.radius,
        node.params.data.height,
        node.params.data.axis,
      );
    case "sphere":
      return sphereGeometry(node.params.data.radius);
    case "disk":
      return diskGeometry(
        node.params.data.radius,
        node.params.data.thickness,
        node.params.data.axis,
      );
    case "triangular_prism":
      return triangularPrismGeometry(
        node.params.data.base,
        node.params.data.triangleHeight,
        node.params.data.depth,
        node.params.data.axis,
      );
  }
}

// ── Color tokens ──────────────────────────────────────────────

const COLOR_DEFAULT = new THREE.Color(0x5af29c);
const COLOR_SELECTED = new THREE.Color(0x6cb8ff);
const COLOR_DISABLED = new THREE.Color(0x555555);
const EDGE_COLOR = new THREE.Color(0x888888);
const EDGE_COLOR_WARNING = new THREE.Color(0xf59e0b);
const EDGE_COLOR_ERROR = new THREE.Color(0xef4444);
const UNIVERSE_COLOR = new THREE.Color(0x44ccff);
const UNIVERSE_COLOR_SELECTED = new THREE.Color(0x7dd3fc);
const REALIZATION_EDGE_COLOR = new THREE.Color(0x14b8a6);
const REALIZATION_FILL_COLOR = new THREE.Color(0x14b8a6);
const MESH_CURRENT_EDGE_COLOR = new THREE.Color(0x67e8f9);
const MESH_STALE_EDGE_COLOR = new THREE.Color(0xf59e0b);
const PICK_DRAG_THRESHOLD_PX = 4;

// ── Math helpers ──────────────────────────────────────────────

const Q_IDENTITY: QuatTuple = [0, 0, 0, 1];
const SCALE_EPSILON = 1e-6;

type BuilderTransform = {
  translation: Vec3;
  rotation: QuatTuple;
  rotationQuat: QuatTuple;
  scale: Vec3;
};

function readTransform(transform: PrimitiveNode["transform"]): BuilderTransform {
  const t = transform as {
    translation: Vec3;
    rotation?: QuatTuple;
    rotationQuat?: QuatTuple;
    scale: Vec3;
  };
  return {
    translation: t.translation,
    rotation: t.rotation ?? t.rotationQuat ?? Q_IDENTITY,
    rotationQuat: t.rotation ?? t.rotationQuat ?? Q_IDENTITY,
    scale: t.scale,
  };
}

function normalizeQuaternionTuple(q: QuatTuple): QuatTuple {
  const quat = new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize();
  return [quat.x, quat.y, quat.z, quat.w];
}

function multiplyQuaternions(left: QuatTuple, right: QuatTuple): QuatTuple {
  const l = new THREE.Quaternion(left[0], left[1], left[2], left[3]);
  const r = new THREE.Quaternion(right[0], right[1], right[2], right[3]);
  l.multiply(r).normalize();
  return [l.x, l.y, l.z, l.w];
}

function snapScalar(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

function snapScaleFactor(value: number, step: number): number {
  if (!(step > 0)) return value;
  const snapped = 1 + Math.round((value - 1) / step) * step;
  return Math.max(step, snapped);
}

// ── Primitive mesh ────────────────────────────────────────────

function BuilderPrimitiveMesh({
  node,
  isSelected,
  validation,
  onClick,
}: {
  node: PrimitiveNode;
  isSelected: boolean;
  validation: PlacementValidation | null;
  onClick: () => void;
}) {
  const geometry = useMemo(() => geometryForPrimitive(node), [node.params]);
  const position = useMemo(
    (): [number, number, number] => {
      const transform = readTransform(node.transform);
      return physicalPositionToScene(transform.translation as Vec3Tuple);
    },
    [node.transform],
  );
  const scale = useMemo(
    (): [number, number, number] => {
      const transform = readTransform(node.transform);
      return dimensionlessScaleToScene(transform.scale as Vec3Tuple);
    },
    [node.transform],
  );
  const quaternion = useMemo(
    (): [number, number, number, number] => {
      const transform = readTransform(node.transform);
      return physicalQuatToScene(transform.rotation);
    },
    [node.transform],
  );

  if (!node.visible) return null;

  const color = !node.enabled
    ? COLOR_DISABLED
    : isSelected
      ? COLOR_SELECTED
      : COLOR_DEFAULT;
  const hasError = Boolean(validation?.selfInvalid || validation?.exceedsUniverse);
  const hasWarning = Boolean(!hasError && validation?.intersectsUniverseBoundary);
  const edgeColor = hasError
    ? EDGE_COLOR_ERROR
    : hasWarning
      ? EDGE_COLOR_WARNING
      : isSelected
        ? COLOR_SELECTED
        : EDGE_COLOR;

  return (
    <group position={position} scale={scale} quaternion={quaternion}>
      <mesh
        geometry={geometry}
        onClick={(event) => {
          event.stopPropagation();
          const dragDeltaPx =
            typeof (event as { delta?: number }).delta === "number"
              ? (event as { delta: number }).delta
              : 0;
          if (dragDeltaPx > PICK_DRAG_THRESHOLD_PX) {
            return;
          }
          onClick();
        }}
      >
        <meshStandardMaterial
          color={color}
          transparent
          opacity={isSelected ? 0.35 : 0.15}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color={edgeColor} linewidth={1} />
      </lineSegments>
    </group>
  );
}

// ── Universe wireframe ────────────────────────────────────────

function UniverseWireframe({
  selected,
  onClick,
}: {
  selected: boolean;
  onClick: () => void;
}) {
  const universe = useGeometryBuilderStore((s) => s.graph.universe);

  const geometry = useMemo(() => {
    const [sx, sy, sz] = physicalScaleToScene(universe.size as Vec3Tuple);
    return new THREE.BoxGeometry(sx, sy, sz);
  }, [universe.size]);

  const position = useMemo(
    (): [number, number, number] =>
      physicalPositionToScene(universe.origin as Vec3Tuple),
    [universe.origin],
  );

  if (!universe.visibility) return null;

  return (
    <group position={position}>
      <mesh
        geometry={geometry}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial
          color={selected ? UNIVERSE_COLOR_SELECTED : UNIVERSE_COLOR}
          linewidth={1}
          transparent
          opacity={selected ? 0.95 : 0.4}
        />
      </lineSegments>
    </group>
  );
}

function BoundsWireframe({
  boundsMin,
  boundsMax,
  edgeColor,
  fillColor,
  fillOpacity,
  edgeOpacity = 0.7,
}: {
  boundsMin: Vec3;
  boundsMax: Vec3;
  edgeColor: THREE.ColorRepresentation;
  fillColor: THREE.ColorRepresentation;
  fillOpacity: number;
  edgeOpacity?: number;
}) {
  const size = useMemo(
    (): [number, number, number] =>
      physicalScaleToScene([
        Math.max(0, boundsMax[0] - boundsMin[0]),
        Math.max(0, boundsMax[1] - boundsMin[1]),
        Math.max(0, boundsMax[2] - boundsMin[2]),
      ]),
    [boundsMax, boundsMin],
  );
  const center = useMemo(
    (): [number, number, number] =>
      physicalPositionToScene([
        (boundsMin[0] + boundsMax[0]) * 0.5,
        (boundsMin[1] + boundsMax[1]) * 0.5,
        (boundsMin[2] + boundsMax[2]) * 0.5,
      ]),
    [boundsMax, boundsMin],
  );
  const geometry = useMemo(() => new THREE.BoxGeometry(size[0], size[1], size[2]), [size]);
  return (
    <group position={center}>
      <mesh geometry={geometry}>
        <meshBasicMaterial
          color={fillColor}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
        />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial
          color={edgeColor}
          transparent
          opacity={edgeOpacity}
        />
      </lineSegments>
    </group>
  );
}

// ── Main layer ────────────────────────────────────────────────

interface BuilderViewportLayerProps {
  showPrimitives?: boolean;
  showUniverse?: boolean;
  showMeshPreview?: boolean;
}

export function BuilderViewportLayer({
  showPrimitives = true,
  showUniverse = true,
  showMeshPreview = false,
}: BuilderViewportLayerProps) {
  const { camera, controls } = useThree();
  const builderEnabled = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const viewportTool = useGeometryBuilderStore((s) => s.viewportTool);
  const snapSettings = useGeometryBuilderStore((s) => s.snapSettings);
  const graphNodes = useGeometryBuilderStore((s) => s.graph.nodes);
  const primitives = useMemo(
    () => graphNodes.filter((node): node is PrimitiveNode => node.kind === "primitive"),
    [graphNodes],
  );
  const builderSelection = useGeometryBuilderStore((s) => s.builderSelection);
  const selectedId = builderSelection.type === "primitive" ? builderSelection.id : null;
  const universeSelected = builderSelection.type === "universe";
  const selectedNode = useMemo(
    () => (selectedId ? primitives.find((node) => node.id === selectedId) ?? null : null),
    [primitives, selectedId],
  );
  const validateNode = useGeometryBuilderStore((s) => s.validateNode);
  const selectBuilderTarget = useGeometryBuilderStore((s) => s.selectBuilderTarget);
  const clearBuilderSelection = useGeometryBuilderStore((s) => s.clearBuilderSelection);
  const beginTransformTransaction = useGeometryBuilderStore((s) => s.beginTransformTransaction);
  const updateTransformPreview = useGeometryBuilderStore((s) => s.updateTransformPreview);
  const commitTransformTransaction = useGeometryBuilderStore((s) => s.commitTransformTransaction);
  const geometryRealization = useGeometryBuilderStore((s) => s.geometryRealization);
  const meshSnapshot = useGeometryBuilderStore((s) => s.meshSnapshot);
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const cameraFocusRequest = useGeometryBuilderStore((s) => s.cameraFocusRequest);

  const baseTransformRef = useRef<BuilderTransform | null>(null);
  const lastAppliedCameraFocusRevisionRef = useRef<number | null>(null);

  const gizmoMode: TransformGizmoMode =
    viewportTool === "rotate"
      ? "rotate"
      : viewportTool === "scale"
        ? "scale"
        : "translate";
  const gizmoActive =
    showPrimitives &&
    selectedNode !== null &&
    !selectedNode.locked &&
    (viewportTool === "move" || viewportTool === "rotate" || viewportTool === "scale");

  const deriveTransformFromDelta = useCallback(
    (delta: TransformGizmoDelta): BuilderTransform | null => {
      const base = baseTransformRef.current;
      if (!selectedNode || !base) {
        return null;
      }

      if (gizmoMode === "translate") {
        let [dx, dy, dz] = sceneDeltaToPhysical(delta.translation as Vec3Tuple);
        if (snapSettings.enabled) {
          dx = snapScalar(dx, snapSettings.translateStepMeters);
          dy = snapScalar(dy, snapSettings.translateStepMeters);
          dz = snapScalar(dz, snapSettings.translateStepMeters);
        }
        return {
          translation: [
            base.translation[0] + dx,
            base.translation[1] + dy,
            base.translation[2] + dz,
          ],
          rotation: base.rotation,
          rotationQuat: base.rotation,
          scale: base.scale,
        };
      }

      if (gizmoMode === "rotate") {
        const deltaPhysical = sceneQuatToPhysical(delta.rotation as QuatTuple);
        const snappedPhysical = snapSettings.enabled
          ? (() => {
              const euler = new THREE.Euler().setFromQuaternion(
                new THREE.Quaternion(
                  deltaPhysical[0],
                  deltaPhysical[1],
                  deltaPhysical[2],
                  deltaPhysical[3],
                ),
                "XYZ",
              );
              const stepRad = (snapSettings.rotateStepDeg * Math.PI) / 180;
              euler.x = snapScalar(euler.x, stepRad);
              euler.y = snapScalar(euler.y, stepRad);
              euler.z = snapScalar(euler.z, stepRad);
              const snapped = new THREE.Quaternion().setFromEuler(euler).normalize();
              return [snapped.x, snapped.y, snapped.z, snapped.w] as QuatTuple;
            })()
          : deltaPhysical;
        const nextRotation = normalizeQuaternionTuple(
          multiplyQuaternions(base.rotation as QuatTuple, snappedPhysical),
        );
        return {
          translation: base.translation,
          rotation: nextRotation,
          rotationQuat: nextRotation,
          scale: base.scale,
        };
      }

      const [sxScene, syScene, szScene] = delta.scale;
      let [sx, sy, sz] = sceneScaleToDimensionless([sxScene, syScene, szScene]);
      if (snapSettings.enabled) {
        sx = snapScaleFactor(sx, snapSettings.scaleStep);
        sy = snapScaleFactor(sy, snapSettings.scaleStep);
        sz = snapScaleFactor(sz, snapSettings.scaleStep);
      }
      return {
        translation: base.translation,
        rotation: base.rotation,
        rotationQuat: base.rotation,
        scale: [
          Math.max(SCALE_EPSILON, base.scale[0] * sx),
          Math.max(SCALE_EPSILON, base.scale[1] * sy),
          Math.max(SCALE_EPSILON, base.scale[2] * sz),
        ],
      };
    },
    [gizmoMode, selectedNode, snapSettings],
  );

  const handleGizmoDragStart = useCallback(() => {
    if (!selectedNode) return;
    const t = readTransform(selectedNode.transform);
    baseTransformRef.current = {
      translation: [...t.translation] as Vec3,
      rotation: [...t.rotation] as QuatTuple,
      rotationQuat: [...t.rotation] as QuatTuple,
      scale: [...t.scale] as Vec3,
    };
    beginTransformTransaction(selectedNode.id);
  }, [beginTransformTransaction, selectedNode]);

  const handleGizmoDragUpdate = useCallback(
    (delta: TransformGizmoDelta) => {
      if (!selectedNode) return;
      const next = deriveTransformFromDelta(delta);
      if (!next) return;
      updateTransformPreview(selectedNode.id, next);
    },
    [deriveTransformFromDelta, selectedNode, updateTransformPreview],
  );

  const handleGizmoDragCommit = useCallback(
    (delta: TransformGizmoDelta) => {
      if (!selectedNode) return;
      const next = deriveTransformFromDelta(delta);
      if (!next) return;
      commitTransformTransaction(selectedNode.id, next);
      baseTransformRef.current = null;
    },
    [commitTransformTransaction, deriveTransformFromDelta, selectedNode],
  );

  const focusBounds = useCallback(
    (minBounds: Vec3, maxBounds: Vec3) => {
      const sceneMin = physicalPositionToScene(minBounds as Vec3Tuple);
      const sceneMax = physicalPositionToScene(maxBounds as Vec3Tuple);
      const min = new THREE.Vector3(
        Math.min(sceneMin[0], sceneMax[0]),
        Math.min(sceneMin[1], sceneMax[1]),
        Math.min(sceneMin[2], sceneMax[2]),
      );
      const max = new THREE.Vector3(
        Math.max(sceneMin[0], sceneMax[0]),
        Math.max(sceneMin[1], sceneMax[1]),
        Math.max(sceneMin[2], sceneMax[2]),
      );
      const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
      const size = new THREE.Vector3().subVectors(max, min);
      const radius = Math.max(size.length() * 0.5, 1e-9);

      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const perspective = camera as THREE.PerspectiveCamera;
        const fovRad = (perspective.fov * Math.PI) / 180;
        const distance = (radius / Math.sin(Math.max(fovRad * 0.5, 1e-3))) * 1.4;
        const direction = new THREE.Vector3(1, 1, 1).normalize();
        perspective.position.copy(center.clone().add(direction.multiplyScalar(distance)));
        perspective.lookAt(center);
      } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.position.copy(center.clone().add(new THREE.Vector3(1, 1, 1).normalize().multiplyScalar(radius * 2)));
        ortho.lookAt(center);
      }

      const anyControls = controls as {
        target?: THREE.Vector3;
        update?: () => void;
      } | null;
      if (anyControls?.target) {
        anyControls.target.copy(center);
      }
      anyControls?.update?.();
    },
    [camera, controls],
  );

  useEffect(() => {
    if (!cameraFocusRequest) return;
    if (lastAppliedCameraFocusRevisionRef.current === cameraFocusRequest.revision) return;

    if (cameraFocusRequest.kind === "selected" && selectedNode) {
      const boundsMin: Vec3 = [Infinity, Infinity, Infinity];
      const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity];
      const geometry = geometryForPrimitive(selectedNode);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox ?? new THREE.Box3(
        new THREE.Vector3(-0.5, -0.5, -0.5),
        new THREE.Vector3(0.5, 0.5, 0.5),
      );
      const transform = readTransform(selectedNode.transform);
      const minLocal: Vec3 = [box.min.x, box.min.y, box.min.z];
      const maxLocal: Vec3 = [box.max.x, box.max.y, box.max.z];
      boundsMin[0] = transform.translation[0] + Math.min(minLocal[0] * transform.scale[0], maxLocal[0] * transform.scale[0]);
      boundsMin[1] = transform.translation[1] + Math.min(minLocal[1] * transform.scale[1], maxLocal[1] * transform.scale[1]);
      boundsMin[2] = transform.translation[2] + Math.min(minLocal[2] * transform.scale[2], maxLocal[2] * transform.scale[2]);
      boundsMax[0] = transform.translation[0] + Math.max(minLocal[0] * transform.scale[0], maxLocal[0] * transform.scale[0]);
      boundsMax[1] = transform.translation[1] + Math.max(minLocal[1] * transform.scale[1], maxLocal[1] * transform.scale[1]);
      boundsMax[2] = transform.translation[2] + Math.max(minLocal[2] * transform.scale[2], maxLocal[2] * transform.scale[2]);
      focusBounds(boundsMin, boundsMax);
      geometry.dispose();
    } else if (cameraFocusRequest.kind === "all") {
      const visiblePrimitives = primitives.filter((primitive) => primitive.visible);
      if (visiblePrimitives.length > 0) {
        const mins: Vec3 = [Infinity, Infinity, Infinity];
        const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const primitive of visiblePrimitives) {
          const geometry = geometryForPrimitive(primitive);
          geometry.computeBoundingBox();
          const box = geometry.boundingBox;
          if (!box) {
            geometry.dispose();
            continue;
          }
          const transform = readTransform(primitive.transform);
          const localMin = box.min;
          const localMax = box.max;
          const primitiveMin: Vec3 = [
            transform.translation[0] + Math.min(localMin.x * transform.scale[0], localMax.x * transform.scale[0]),
            transform.translation[1] + Math.min(localMin.y * transform.scale[1], localMax.y * transform.scale[1]),
            transform.translation[2] + Math.min(localMin.z * transform.scale[2], localMax.z * transform.scale[2]),
          ];
          const primitiveMax: Vec3 = [
            transform.translation[0] + Math.max(localMin.x * transform.scale[0], localMax.x * transform.scale[0]),
            transform.translation[1] + Math.max(localMin.y * transform.scale[1], localMax.y * transform.scale[1]),
            transform.translation[2] + Math.max(localMin.z * transform.scale[2], localMax.z * transform.scale[2]),
          ];
          mins[0] = Math.min(mins[0], primitiveMin[0]);
          mins[1] = Math.min(mins[1], primitiveMin[1]);
          mins[2] = Math.min(mins[2], primitiveMin[2]);
          maxs[0] = Math.max(maxs[0], primitiveMax[0]);
          maxs[1] = Math.max(maxs[1], primitiveMax[1]);
          maxs[2] = Math.max(maxs[2], primitiveMax[2]);
          geometry.dispose();
        }
        if (Number.isFinite(mins[0]) && Number.isFinite(maxs[0])) {
          focusBounds(mins, maxs);
        }
      }
    }
    lastAppliedCameraFocusRevisionRef.current = cameraFocusRequest.revision;
  }, [cameraFocusRequest, focusBounds, primitives, selectedNode]);

  const meshPreviewCurrent =
    geometryRealization != null &&
    meshSnapshot != null &&
    meshSnapshot.meshState === "ready" &&
    meshSnapshot.sourceGeometryRevision === geometryRealization.revision &&
    !dirty.meshDirty;

  if (!builderEnabled) return null;

  return (
    <group onPointerMissed={() => clearBuilderSelection()}>
      {showUniverse ? (
        <UniverseWireframe
          selected={universeSelected}
          onClick={() => selectBuilderTarget({ type: "universe", id: "universe" })}
        />
      ) : null}
      {showPrimitives
        ? primitives.map((node) => {
            const isSelected = node.id === selectedId;
            const validation = node.enabled ? validateNode(node.id) : null;
            if (isSelected && gizmoActive) {
              return (
                <TransformGizmoLayer
                  key={node.id}
                  active
                  mode={gizmoMode}
                  onDragStart={handleGizmoDragStart}
                  onDragUpdate={handleGizmoDragUpdate}
                  onDragCommit={handleGizmoDragCommit}
                >
                  <BuilderPrimitiveMesh
                    node={node}
                    isSelected
                    validation={validation}
                    onClick={() => selectBuilderTarget({ type: "primitive", id: node.id })}
                  />
                </TransformGizmoLayer>
              );
            }
            return (
              <BuilderPrimitiveMesh
                key={node.id}
                node={node}
                isSelected={isSelected}
                validation={validation}
                onClick={() => selectBuilderTarget({ type: "primitive", id: node.id })}
              />
            );
          })
        : null}
      {showMeshPreview && geometryRealization
        ? geometryRealization.bodies.map((body) => (
            <BoundsWireframe
              key={`realization-${body.sourceNodeId}`}
              boundsMin={body.boundsMin}
              boundsMax={body.boundsMax}
              edgeColor={REALIZATION_EDGE_COLOR}
              fillColor={REALIZATION_FILL_COLOR}
              fillOpacity={0.04}
              edgeOpacity={0.55}
            />
          ))
        : null}
      {showMeshPreview && geometryRealization && meshSnapshot
        ? geometryRealization.bodies.map((body) => (
            <BoundsWireframe
              key={`mesh-${body.sourceNodeId}`}
              boundsMin={body.boundsMin}
              boundsMax={body.boundsMax}
              edgeColor={meshPreviewCurrent ? MESH_CURRENT_EDGE_COLOR : MESH_STALE_EDGE_COLOR}
              fillColor={meshPreviewCurrent ? MESH_CURRENT_EDGE_COLOR : MESH_STALE_EDGE_COLOR}
              fillOpacity={meshPreviewCurrent ? 0.02 : 0.0}
              edgeOpacity={meshPreviewCurrent ? 0.9 : 0.45}
            />
          ))
        : null}
    </group>
  );
}
