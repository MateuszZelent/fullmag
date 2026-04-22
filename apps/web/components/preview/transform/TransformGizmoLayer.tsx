"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import * as THREE from "three";
import { PivotControls } from "@react-three/drei";

export type TransformGizmoMode = "translate" | "rotate" | "scale";

export interface TransformGizmoDelta {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface TransformGizmoLayerProps {
  /** Whether gizmo is active (object selected + tool is move/rotate/scale) */
  active: boolean;
  /** Active gizmo mode. */
  mode?: TransformGizmoMode;
  /** Which axes to show — defaults to all */
  activeAxes?: [boolean, boolean, boolean];
  /** Fixed pixel size for gizmo */
  scale?: number;
  /** Callback when drag ends with translation delta */
  onTranslate?: (dx: number, dy: number, dz: number) => void;
  /** Called once when drag starts. */
  onDragStart?: () => void;
  /** Called continuously during drag with decomposed delta transform. */
  onDragUpdate?: (delta: TransformGizmoDelta) => void;
  /** Called once at drag end with decomposed delta transform. */
  onDragCommit?: (delta: TransformGizmoDelta) => void;
  children: React.ReactNode;
}

/**
 * Unified transform gizmo layer.
 * Wraps children in PivotControls when active.
 * Keeps the gizmo on a controlled matrix so drag state lives in one place.
 */
export function TransformGizmoLayer({
  active,
  mode = "translate",
  activeAxes = [true, true, true],
  scale = 92,
  onTranslate,
  onDragStart,
  onDragUpdate,
  onDragCommit,
  children,
}: TransformGizmoLayerProps) {
  const [matrix] = useState(() => new THREE.Matrix4());
  const dragPositionRef = useRef(new THREE.Vector3());
  const scratchQuaternionRef = useRef(new THREE.Quaternion());
  const scratchScaleRef = useRef(new THREE.Vector3());

  useEffect(() => {
    if (!active) {
      matrix.identity();
      dragPositionRef.current.set(0, 0, 0);
    }
  }, [active, matrix]);

  const handleDrag = useCallback((localMatrix: THREE.Matrix4) => {
    matrix.copy(localMatrix);
    localMatrix.decompose(
      dragPositionRef.current,
      scratchQuaternionRef.current,
      scratchScaleRef.current,
    );
    onDragUpdate?.({
      translation: [
        dragPositionRef.current.x,
        dragPositionRef.current.y,
        dragPositionRef.current.z,
      ],
      rotation: [
        scratchQuaternionRef.current.x,
        scratchQuaternionRef.current.y,
        scratchQuaternionRef.current.z,
        scratchQuaternionRef.current.w,
      ],
      scale: [
        scratchScaleRef.current.x,
        scratchScaleRef.current.y,
        scratchScaleRef.current.z,
      ],
    });
  }, [matrix, onDragUpdate]);

  const handleDragEnd = useCallback(() => {
    const p = dragPositionRef.current;
    const q = scratchQuaternionRef.current;
    const s = scratchScaleRef.current;
    const delta: TransformGizmoDelta = {
      translation: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [s.x, s.y, s.z],
    };
    if (Math.abs(p.x) > 1e-12 || Math.abs(p.y) > 1e-12 || Math.abs(p.z) > 1e-12) {
      onTranslate?.(p.x, p.y, p.z);
    }
    onDragCommit?.(delta);
    matrix.identity();
    dragPositionRef.current.set(0, 0, 0);
    scratchQuaternionRef.current.set(0, 0, 0, 1);
    scratchScaleRef.current.set(1, 1, 1);
  }, [matrix, onDragCommit, onTranslate]);

  const handleDragStart = useCallback(() => {
    onDragStart?.();
  }, [onDragStart]);

  const disableAxes = mode === "rotate";
  const disableSliders = mode !== "translate";

  if (!active) {
    return <>{children}</>;
  }

  return (
    <PivotControls
      depthTest={false}
      lineWidth={2.6}
      axisColors={["#ff7a7a", "#5af29c", "#6cb8ff"]}
      scale={scale}
      fixed
      autoTransform={false}
      matrix={matrix}
      activeAxes={activeAxes}
      disableAxes={disableAxes}
      disableSliders={disableSliders}
      disableRotations={mode !== "rotate"}
      disableScaling={mode !== "scale"}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
    >
      <group>{children}</group>
    </PivotControls>
  );
}
