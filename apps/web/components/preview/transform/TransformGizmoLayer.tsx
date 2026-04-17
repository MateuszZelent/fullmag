"use client";

import { useRef, useCallback, useEffect } from "react";
import * as THREE from "three";
import { PivotControls } from "@react-three/drei";

interface TransformGizmoLayerProps {
  /** Whether gizmo is active (object selected + tool is move/rotate/scale) */
  active: boolean;
  /** Which axes to show — defaults to all */
  activeAxes?: [boolean, boolean, boolean];
  /** Fixed pixel size for gizmo */
  scale?: number;
  /** Callback when drag ends with translation delta */
  onTranslate?: (dx: number, dy: number, dz: number) => void;
  children: React.ReactNode;
}

/**
 * Unified transform gizmo layer.
 * Wraps children in PivotControls when active.
 * Keeps the gizmo on a controlled matrix so drag state lives in one place.
 */
export function TransformGizmoLayer({
  active,
  activeAxes = [true, true, true],
  scale = 75,
  onTranslate,
  children,
}: TransformGizmoLayerProps) {
  const matrixRef = useRef(new THREE.Matrix4());
  const dragPositionRef = useRef(new THREE.Vector3());
  const scratchQuaternionRef = useRef(new THREE.Quaternion());
  const scratchScaleRef = useRef(new THREE.Vector3());

  useEffect(() => {
    if (!active) {
      matrixRef.current.identity();
      dragPositionRef.current.set(0, 0, 0);
    }
  }, [active]);

  const handleDrag = useCallback((localMatrix: THREE.Matrix4) => {
    matrixRef.current.copy(localMatrix);
    localMatrix.decompose(
      dragPositionRef.current,
      scratchQuaternionRef.current,
      scratchScaleRef.current,
    );
  }, []);

  const handleDragEnd = useCallback(() => {
    const p = dragPositionRef.current;
    if (Math.abs(p.x) > 1e-12 || Math.abs(p.y) > 1e-12 || Math.abs(p.z) > 1e-12) {
      onTranslate?.(p.x, p.y, p.z);
    }
    matrixRef.current.identity();
    dragPositionRef.current.set(0, 0, 0);
  }, [onTranslate]);

  if (!active) {
    return <>{children}</>;
  }

  return (
    <PivotControls
      depthTest={false}
      lineWidth={2}
      axisColors={["#f87171", "#4ade80", "#60a5fa"]}
      scale={scale}
      fixed
      autoTransform={false}
      matrix={matrixRef.current}
      activeAxes={activeAxes}
      disableRotations
      disableScaling
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
    >
      <group>{children}</group>
    </PivotControls>
  );
}
