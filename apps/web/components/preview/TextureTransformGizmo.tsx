"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { PivotControls } from "@react-three/drei";
import type { TextureTransform3D } from "@/lib/textureTransform";
import {
  composePivotedTextureTransformMatrix,
  textureTransformFromPivotMatrix,
  textureTransformToPivotFrame,
  type Vec3,
} from "@/lib/textureTransformMath";
import { swapYZQuat, swapYZVec3 } from "./transform/axisConvention";

export type TextureGizmoMode = "translate" | "rotate" | "scale";
export type TexturePreviewProxy = "none" | "disc" | "box" | "cylinder" | "wall" | "wave";

/**
 * Whether to apply a Y↔Z axis swap between the physical coordinate system
 * (used by TextureTransform3D, where Y is the vertical/physical-Y axis)
 * and the Three.js scene coordinate system (where the FDM viewport swaps
 * scene-Y = physical-Z, scene-Z = physical-Y via axisLabels=["x","z","y"]).
 *
 * When `true`, the gizmo converts physical→scene on mount and scene→physical
 * on drag, so the transform values remain in physical coordinates.
 */
interface Props {
  transform: TextureTransform3D;
  mode: TextureGizmoMode;
  visible?: boolean;
  previewProxy?: TexturePreviewProxy;
  showPreviewProxy?: boolean;
  syncPivotWithTranslation?: boolean;
  /** Swap Y↔Z between physical TextureTransform3D and Three.js scene. Default false. */
  swapYZ?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onLiveChange?: (next: TextureTransform3D) => void;
  onCommit?: (next: TextureTransform3D) => void;
}

function gizmoDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean((window as Window & { __FULLMAG_GIZMO_DEBUG__?: boolean }).__FULLMAG_GIZMO_DEBUG__);
}

function quatToEulerDeg(
  q: [number, number, number, number],
): [number, number, number] {
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), "XYZ");
  return [
    THREE.MathUtils.radToDeg(euler.x),
    THREE.MathUtils.radToDeg(euler.y),
    THREE.MathUtils.radToDeg(euler.z),
  ];
}

function summarizeTransform(transform: TextureTransform3D) {
  return {
    translation: transform.translation,
    rotation_quat: transform.rotation_quat,
    rotation_euler_deg_xyz: quatToEulerDeg(transform.rotation_quat),
    scale: transform.scale,
    pivot: transform.pivot,
  };
}

function toSceneTextureTransform(
  transform: TextureTransform3D,
  doSwap: boolean,
): TextureTransform3D {
  return {
    translation: doSwap ? swapYZVec3(transform.translation) : [...transform.translation],
    rotation_quat: doSwap ? swapYZQuat(transform.rotation_quat) : [...transform.rotation_quat],
    scale: doSwap ? swapYZVec3(transform.scale) : [...transform.scale],
    pivot: doSwap ? swapYZVec3(transform.pivot) : [...transform.pivot],
  };
}

function decomposeMatrixTransform(matrix: THREE.Matrix4) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

function summarizeSceneMatrix(matrix: THREE.Matrix4) {
  const { position, quaternion, scale } = decomposeMatrixTransform(matrix);
  return {
    translation: [position.x, position.y, position.z] as [number, number, number],
    rotation_quat: [
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    ] as [number, number, number, number],
    rotation_euler_deg_xyz: quatToEulerDeg([
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    ]),
    scale: [scale.x, scale.y, scale.z] as [number, number, number],
  };
}

function snapshotMatrixTransform(
  matrix: THREE.Matrix4,
  baseTransform: TextureTransform3D,
  mode: TextureGizmoMode,
  syncPivotWithTranslation: boolean,
  doSwap: boolean,
): TextureTransform3D {
  const scenePivot = doSwap ? swapYZVec3(baseTransform.pivot) : [...baseTransform.pivot];
  const sceneTransform = textureTransformFromPivotMatrix(matrix, scenePivot as Vec3);
  let translation: [number, number, number] = [...sceneTransform.translation];
  let rotation_quat: [number, number, number, number] = [...sceneTransform.rotation_quat];
  let scaleVec: [number, number, number] = [...sceneTransform.scale];

  // Convert scene → physical
  if (doSwap) {
    translation = swapYZVec3(translation);
    rotation_quat = swapYZQuat(rotation_quat);
    scaleVec = swapYZVec3(scaleVec);
  }

  const pivot = [...baseTransform.pivot] as [number, number, number];

  // Keep pivot synchronized with live translation when requested.
  // This makes the detailed numeric editor and 3D gizmo stay in lockstep.
  if (syncPivotWithTranslation && mode === "translate") {
    const dx = translation[0] - baseTransform.translation[0];
    const dy = translation[1] - baseTransform.translation[1];
    const dz = translation[2] - baseTransform.translation[2];
    pivot[0] += dx;
    pivot[1] += dy;
    pivot[2] += dz;
  }

  return {
    translation,
    rotation_quat,
    scale: scaleVec,
    pivot,
  };
}

function PreviewProxyMesh({ proxy }: { proxy: TexturePreviewProxy }) {
  if (proxy === "none") {
    return (
      <mesh>
        <sphereGeometry args={[0.18, 20, 20]} />
        <meshBasicMaterial color="#89dceb" wireframe transparent opacity={0.55} />
      </mesh>
    );
  }
  if (proxy === "disc") {
    return (
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.7, 0.7, 0.06, 48, 1, true]} />
        <meshBasicMaterial color="#89dceb" wireframe transparent opacity={0.4} />
      </mesh>
    );
  }
  if (proxy === "cylinder") {
    return (
      <mesh>
        <cylinderGeometry args={[0.45, 0.45, 1.2, 28, 1, true]} />
        <meshBasicMaterial color="#89dceb" wireframe transparent opacity={0.35} />
      </mesh>
    );
  }
  if (proxy === "wall") {
    return (
      <group>
        <mesh>
          <boxGeometry args={[0.2, 1.2, 1.2]} />
          <meshBasicMaterial color="#89dceb" wireframe transparent opacity={0.4} />
        </mesh>
        <mesh position={[0.4, 0, 0]}>
          <boxGeometry args={[0.6, 1.2, 1.2]} />
          <meshBasicMaterial color="#f38ba8" wireframe transparent opacity={0.15} />
        </mesh>
        <mesh position={[-0.4, 0, 0]}>
          <boxGeometry args={[0.6, 1.2, 1.2]} />
          <meshBasicMaterial color="#89b4fa" wireframe transparent opacity={0.15} />
        </mesh>
      </group>
    );
  }
  if (proxy === "wave") {
    return (
      <group>
        <mesh>
          <boxGeometry args={[1.5, 0.6, 0.6]} />
          <meshBasicMaterial color="#89dceb" wireframe transparent opacity={0.25} />
        </mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.02, 0.02, 1.8, 8]} />
          <meshBasicMaterial color="#f5c2e7" transparent opacity={0.8} />
        </mesh>
      </group>
    );
  }
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color="#89dceb" wireframe transparent opacity={0.3} />
    </mesh>
  );
}

export default function TextureTransformGizmo({
  transform,
  mode,
  visible = true,
  previewProxy = "box",
  showPreviewProxy = false,
  syncPivotWithTranslation = false,
  swapYZ = false,
  onDragStart,
  onDragEnd,
  onLiveChange,
  onCommit,
}: Props) {
  const lastSnapshotLogRef = useRef<string>("");
  const sceneTransform = toSceneTextureTransform(transform, swapYZ);
  const pivotFrame = textureTransformToPivotFrame(sceneTransform);
  const matrixRef = useRef<THREE.Matrix4>(composePivotedTextureTransformMatrix(sceneTransform));

  useLayoutEffect(() => {
    composePivotedTextureTransformMatrix(sceneTransform, matrixRef.current);
  }, [sceneTransform]);

  useEffect(() => {
    if (!gizmoDebugEnabled() || !visible) {
      return;
    }
    const signature = JSON.stringify({
      mode,
      swapYZ,
      transform,
      sceneMatrix: summarizeSceneMatrix(matrixRef.current),
    });
    if (signature === lastSnapshotLogRef.current) {
      return;
    }
    lastSnapshotLogRef.current = signature;
    console.groupCollapsed(
      `[GizmoSync] TextureTransformGizmo mode=${mode} swapYZ=${swapYZ ? "on" : "off"}`,
    );
    console.log("physical transform input", summarizeTransform(transform));
    console.log("scene pivot frame", pivotFrame);
    console.log("scene transform passed to PivotControls", summarizeSceneMatrix(matrixRef.current));
    console.groupEnd();
  }, [mode, pivotFrame, swapYZ, transform, visible]);

  if (!visible) {
    return null;
  }

  return (
    <PivotControls
      depthTest={false}
      fixed
      scale={75}
      lineWidth={2}
      autoTransform={false}
      matrix={matrixRef.current}
      disableAxes={false}
      activeAxes={[true, true, true]}
      disableRotations={mode !== "rotate"}
      disableSliders={false}
      disableScaling={mode !== "scale"}
      onDragStart={() => {
        onDragStart?.();
        if (!gizmoDebugEnabled()) {
          return;
        }
        console.groupCollapsed(
          `[GizmoSync] drag-start mode=${mode} swapYZ=${swapYZ ? "on" : "off"}`,
        );
        console.log("scene pivot frame", pivotFrame);
        console.log("scene matrix", summarizeSceneMatrix(matrixRef.current));
        console.groupEnd();
      }}
      onDrag={(localMatrix) => {
        matrixRef.current.copy(localMatrix);
        if (onLiveChange) {
          onLiveChange(
            snapshotMatrixTransform(
              localMatrix,
              transform,
              mode,
              syncPivotWithTranslation,
              swapYZ,
            ),
          );
        }
      }}
      onDragEnd={() => {
        onDragEnd?.();
        const committed = snapshotMatrixTransform(
          matrixRef.current,
          transform,
          mode,
          syncPivotWithTranslation,
          swapYZ,
        );
        if (gizmoDebugEnabled()) {
          console.groupCollapsed(
            `[GizmoSync] drag-end mode=${mode} swapYZ=${swapYZ ? "on" : "off"}`,
          );
          console.log("scene matrix", summarizeSceneMatrix(matrixRef.current));
          console.log("committed physical transform", summarizeTransform(committed));
          console.groupEnd();
        }
        onCommit?.(committed);
      }}
    >
      <group>
        {showPreviewProxy ? (
          <group position={pivotFrame.childOffset}>
            <PreviewProxyMesh proxy={previewProxy} />
          </group>
        ) : (
          <group position={pivotFrame.childOffset}>
            <mesh>
              <sphereGeometry args={[0.01, 6, 6]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          </group>
        )}
      </group>
    </PivotControls>
  );
}
