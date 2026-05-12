"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { PivotControls } from "@react-three/drei";
import type { TextureTransform3D } from "@/lib/textureTransform";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";
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
  const fillMaterial = (
    color: string,
    opacity: number,
  ) => <meshStandardMaterial color={color} transparent opacity={opacity} roughness={0.34} metalness={0.08} />;
  const wireMaterial = (
    color: string,
    opacity: number,
  ) => <meshBasicMaterial color={color} wireframe transparent opacity={opacity} depthWrite={false} />;
  if (proxy === "none") {
    return (
      <group>
        <mesh>
          <sphereGeometry args={[0.22, 24, 24]} />
          {fillMaterial("#8ad9ff", 0.16)}
        </mesh>
        <mesh>
          <sphereGeometry args={[0.22, 16, 16]} />
          {wireMaterial("#d5f1ff", 0.5)}
        </mesh>
      </group>
    );
  }
  if (proxy === "disc") {
    return (
      <group>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.74, 0.74, 0.08, 56]} />
          {fillMaterial("#7ed9ff", 0.14)}
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.72, 0.028, 12, 72]} />
          {wireMaterial("#d4f0ff", 0.78)}
        </mesh>
      </group>
    );
  }
  if (proxy === "cylinder") {
    return (
      <group>
        <mesh>
          <cylinderGeometry args={[0.48, 0.48, 1.26, 36]} />
          {fillMaterial("#86dbff", 0.12)}
        </mesh>
        <mesh>
          <cylinderGeometry args={[0.48, 0.48, 1.26, 28, 1, true]} />
          {wireMaterial("#d4f0ff", 0.62)}
        </mesh>
      </group>
    );
  }
  if (proxy === "wall") {
    return (
      <group>
        <mesh>
          <boxGeometry args={[0.2, 1.2, 1.2]} />
          {fillMaterial("#85dbff", 0.18)}
        </mesh>
        <mesh>
          <boxGeometry args={[0.2, 1.2, 1.2]} />
          {wireMaterial("#d7f2ff", 0.62)}
        </mesh>
        <mesh position={[0.4, 0, 0]}>
          <boxGeometry args={[0.6, 1.2, 1.2]} />
          {wireMaterial("#ff9fc1", 0.18)}
        </mesh>
        <mesh position={[-0.4, 0, 0]}>
          <boxGeometry args={[0.6, 1.2, 1.2]} />
          {wireMaterial("#92bcff", 0.18)}
        </mesh>
      </group>
    );
  }
  if (proxy === "wave") {
    return (
      <group>
        <mesh>
          <boxGeometry args={[1.5, 0.6, 0.6]} />
          {fillMaterial("#8ad9ff", 0.1)}
        </mesh>
        <mesh>
          <boxGeometry args={[1.5, 0.6, 0.6]} />
          {wireMaterial("#d7f1ff", 0.38)}
        </mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 1.8, 10]} />
          {fillMaterial("#f5c2e7", 0.72)}
        </mesh>
      </group>
    );
  }
  return (
    <group>
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        {fillMaterial("#86dbff", 0.12)}
      </mesh>
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        {wireMaterial("#d5f1ff", 0.52)}
      </mesh>
    </group>
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
  const [matrix] = useState(() => composePivotedTextureTransformMatrix(sceneTransform));

  useLayoutEffect(() => {
    composePivotedTextureTransformMatrix(sceneTransform, matrix);
  }, [matrix, sceneTransform]);

  useEffect(() => {
    if (!gizmoDebugEnabled() || !visible) {
      return;
    }
    const signature = JSON.stringify({
      mode,
      swapYZ,
      transform,
      sceneMatrix: summarizeSceneMatrix(matrix),
    });
    if (signature === lastSnapshotLogRef.current) {
      return;
    }
    lastSnapshotLogRef.current = signature;
    writeFrontendDiagnosticConsole(
      "groupCollapsed",
      `[GizmoSync] TextureTransformGizmo mode=${mode} swapYZ=${swapYZ ? "on" : "off"}`,
    );
    writeFrontendDiagnosticConsole("log", "physical transform input", summarizeTransform(transform));
    writeFrontendDiagnosticConsole("log", "scene pivot frame", pivotFrame);
    writeFrontendDiagnosticConsole("log", "scene transform passed to PivotControls", summarizeSceneMatrix(matrix));
    writeFrontendDiagnosticConsole("groupEnd");
  }, [matrix, mode, pivotFrame, swapYZ, transform, visible]);

  if (!visible) {
    return null;
  }

  return (
    <PivotControls
      depthTest={false}
      fixed
      scale={94}
      lineWidth={2.8}
      autoTransform={false}
      matrix={matrix}
      disableAxes={false}
      activeAxes={[true, true, true]}
      axisColors={["#ff7d7d", "#5cf29d", "#6fbcff"]}
      disableRotations={mode !== "rotate"}
      disableSliders={false}
      disableScaling={mode !== "scale"}
      onDragStart={() => {
        onDragStart?.();
        if (!gizmoDebugEnabled()) {
          return;
        }
        writeFrontendDiagnosticConsole(
          "groupCollapsed",
          `[GizmoSync] drag-start mode=${mode} swapYZ=${swapYZ ? "on" : "off"}`,
        );
        writeFrontendDiagnosticConsole("log", "scene pivot frame", pivotFrame);
        writeFrontendDiagnosticConsole("log", "scene matrix", summarizeSceneMatrix(matrix));
        writeFrontendDiagnosticConsole("groupEnd");
      }}
      onDrag={(localMatrix) => {
        matrix.copy(localMatrix);
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
          matrix,
          transform,
          mode,
          syncPivotWithTranslation,
          swapYZ,
        );
        if (gizmoDebugEnabled()) {
          writeFrontendDiagnosticConsole(
            "groupCollapsed",
            `[GizmoSync] drag-end mode=${mode} swapYZ=${swapYZ ? "on" : "off"}`,
          );
          writeFrontendDiagnosticConsole("log", "scene matrix", summarizeSceneMatrix(matrix));
          writeFrontendDiagnosticConsole("log", "committed physical transform", summarizeTransform(committed));
          writeFrontendDiagnosticConsole("groupEnd");
        }
        onCommit?.(committed);
      }}
    >
      <group>
        <ambientLight intensity={0.7} />
        <directionalLight position={[2.4, 2.4, 2.8]} intensity={0.55} />
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
