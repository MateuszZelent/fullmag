"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { PivotControls } from "@react-three/drei";
import type { TextureTransform3D } from "@/lib/textureTransform";

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

/** Swap Y↔Z in a 3-element tuple. */
function swapYZVec3(v: [number, number, number]): [number, number, number] {
  return [v[0], v[2], v[1]];
}

/** Swap Y↔Z in a quaternion (x,y,z,w). Equivalent to conjugating by a Y↔Z swap. */
function swapYZQuat(q: [number, number, number, number]): [number, number, number, number] {
  return [q[0], q[2], q[1], q[3]];
}

function toObject3DTransform(transform: TextureTransform3D, doSwap: boolean) {
  const t = doSwap ? swapYZVec3(transform.translation) : transform.translation;
  const q = doSwap ? swapYZQuat(transform.rotation_quat) : transform.rotation_quat;
  const s = doSwap ? swapYZVec3(transform.scale) : transform.scale;
  const position = new THREE.Vector3(...t);
  const quaternion = new THREE.Quaternion(...q);
  const scale = new THREE.Vector3(...s);
  return { position, quaternion, scale };
}

function snapshotGroupTransform(
  group: THREE.Group,
  baseTransform: TextureTransform3D,
  mode: TextureGizmoMode,
  syncPivotWithTranslation: boolean,
  doSwap: boolean,
): TextureTransform3D {
  let translation: [number, number, number] = [
    group.position.x,
    group.position.y,
    group.position.z,
  ];
  let rotation_quat: [number, number, number, number] = [
    group.quaternion.x,
    group.quaternion.y,
    group.quaternion.z,
    group.quaternion.w,
  ];
  let scaleVec: [number, number, number] = [group.scale.x, group.scale.y, group.scale.z];

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
  const groupRef = useRef<THREE.Group>(null);

  const initial = useMemo(() => toObject3DTransform(transform, swapYZ), [transform, swapYZ]);

  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.position.copy(initial.position);
    groupRef.current.quaternion.copy(initial.quaternion);
    groupRef.current.scale.copy(initial.scale);
  }, [initial]);

  if (!visible) {
    return null;
  }

  return (
    <PivotControls
      depthTest={false}
      fixed
      scale={75}
      lineWidth={2}
      disableAxes={false}
      activeAxes={[true, true, true]}
      disableRotations={mode !== "rotate"}
      disableSliders={false}
      disableScaling={mode !== "scale"}
      onDragStart={onDragStart}
      onDrag={() => {
        const group = groupRef.current;
        if (!group || !onLiveChange) {
          return;
        }
        onLiveChange(snapshotGroupTransform(group, transform, mode, syncPivotWithTranslation, swapYZ));
      }}
      onDragEnd={() => {
        onDragEnd?.();
        const group = groupRef.current;
        if (!group || !onCommit) {
          return;
        }
        onCommit(snapshotGroupTransform(group, transform, mode, syncPivotWithTranslation, swapYZ));
      }}
    >
      <group ref={groupRef}>
        {showPreviewProxy ? (
          <PreviewProxyMesh proxy={previewProxy} />
        ) : (
          <mesh>
            <sphereGeometry args={[0.01, 6, 6]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        )}
      </group>
    </PivotControls>
  );
}
