"use client";

/**
 * HSL Colour Sphere – R3F version.
 *
 * A small inset 3D colour reference that rotates in sync with the main
 * viewport camera. The sphere surface uses the exact same magnetizationHSL
 * colour mapping as arrow/voxel rendering.
 *
 * Axis labels (X / Y / Z) and the sampled color map follow the same effective
 * preview-axis convention as the viewport. In practice we want:
 * - X = in-plane horizontal
 * - Y = in-plane depth
 * - Z = out-of-plane / thickness / vertical
 *
 * That means the screen-up direction corresponds to +Z, not +Y, so the
 * reference sphere must swap Y/Z when sampling the HSL map for FEM/FDM.
 */

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { Text, Billboard, Line } from "@react-three/drei";
import { magnetizationHslColor } from "./magnetizationColor";
import { cn } from "@/lib/utils";
import { useCanvasHost } from "./shared/useCanvasHost";
import {
  applyAxisConventionVec3,
  sceneAxisDescriptor,
  type AxisConvention,
} from "./transform/axisConvention";
import {
  cameraOrientationSignature,
  captureOrientationDebugSnapshot,
  type OrientationDebugSnapshot,
  type SceneCameraHandle,
} from "./camera/cameraOrientation";
import { useSceneCameraChange } from "./camera/useSceneCameraChange";

/* ── Types ─────────────────────────────────────────────────── */

interface HslSphereProps {
  sceneRef: MutableRefObject<{
    camera: THREE.PerspectiveCamera | THREE.Camera;
    controls: any;
  } | null>;
  axisConvention?: AxisConvention;
  size?: number;
  compact?: boolean;
  className?: string;
  anchorClassName?: string;
  embedded?: boolean;
  visible?: boolean;
  onOrientationSnapshot?: (snapshot: OrientationDebugSnapshot) => void;
}

/* ── Constants ─────────────────────────────────────────────── */

const SIZE = 144;
const SPHERE_RADIUS = 0.9;
const SEGMENTS = 64;
/* ── Axis label component ─────────────────────────────────── */

function AxisLabel({ text, color, position, fontSize = 0.28 }: {
  text: string;
  color: string;
  position: [number, number, number];
  fontSize?: number;
}) {
  return (
    <Billboard position={position}>
      <Text
        fontSize={fontSize}
        color={color}
        anchorX="center"
        anchorY="middle"
        fontWeight="bold"
      >
        {text}
      </Text>
    </Billboard>
  );
}

/* ── Camera sync component ────────────────────────────────── */

function CameraSync({
  mainCameraRef,
  onOrientationSnapshot,
}: {
  mainCameraRef: MutableRefObject<SceneCameraHandle | null>;
  onOrientationSnapshot?: (snapshot: OrientationDebugSnapshot) => void;
}) {
  const { camera, invalidate } = useThree();
  const lastOrientationRef = useRef("");
  const syncCamera = useCallback(() => {
    const main = mainCameraRef.current;
    if (!main) {
      return;
    }
    const quat = main.camera.quaternion;
    const sig = cameraOrientationSignature(main.camera);
    if (sig === lastOrientationRef.current) {
      return;
    }
    // Mirror the full orientation contract from the main camera.
    camera.up.copy(main.camera.up);
    camera.quaternion.copy(quat);
    camera.position.set(0, 0, 3).applyQuaternion(camera.quaternion);
    camera.updateMatrixWorld();
    lastOrientationRef.current = sig;
    onOrientationSnapshot?.(captureOrientationDebugSnapshot(camera));
    invalidate();
  }, [camera, invalidate, mainCameraRef, onOrientationSnapshot]);
  useSceneCameraChange(mainCameraRef, syncCamera);

  return null;
}

function CanvasVisibilityInvalidator({ visible }: { visible: boolean }) {
  const { camera, gl, invalidate, scene } = useThree();
  const previousVisibleRef = useRef(false);
  useEffect(() => {
    const wasVisible = previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!visible || wasVisible) {
      return;
    }
    let frame = 0;
    let disposed = false;
    const kick = () => {
      if (disposed) {
        return;
      }
      invalidate();
      gl.render(scene, camera);
      frame += 1;
      if (frame < 6) {
        window.requestAnimationFrame(kick);
      }
    };
    kick();
    return () => {
      disposed = true;
    };
  }, [camera, gl, invalidate, scene, visible]);
  return null;
}

/* ── Component ─────────────────────────────────────────────── */

export default function HslSphere({
  sceneRef,
  axisConvention = "identity",
  size = SIZE,
  compact = false,
  className = "",
  anchorClassName,
  embedded = false,
  visible = true,
  onOrientationSnapshot,
}: HslSphereProps) {
  const sphereSize = compact ? Math.round(size * 0.82) : size;
  const { hostRef, hostNode } = useCanvasHost<HTMLDivElement>();
  return (
    <div
      ref={hostRef}
      className={cn(
        "fem-hsl-gizmo pointer-events-auto relative overflow-hidden rounded-[28px] border backdrop-blur-md",
        embedded ? "self-start" : null,
        anchorClassName,
        className,
      )}
      style={{
        width: sphereSize,
        height: sphereSize,
      }}
    >
      <div className="fem-hsl-gizmo__frame pointer-events-none absolute inset-[8px] rounded-[22px] border" />
      <div className="fem-hsl-gizmo__ring pointer-events-none absolute inset-[16px] rounded-full border" />
      <div className="fem-hsl-gizmo__title pointer-events-none absolute inset-x-4 top-3 flex items-center justify-between text-[0.68rem] font-bold uppercase tracking-[0.16em]">
        <span>HSL</span>
        <span className="fem-hsl-gizmo__title-accent">Gizmo</span>
      </div>
      {hostNode ? (
        <Canvas
          eventSource={hostNode}
          frameloop="demand"
          orthographic
          camera={{
            left: -1.4,
            right: 1.4,
            top: 1.4,
            bottom: -1.4,
            near: 0.1,
            far: 10,
            position: [0, 0, 3],
          }}
          gl={{ alpha: true, antialias: true }}
          dpr={Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2)}
          style={{
            width: sphereSize,
            height: sphereSize,
            borderRadius: 28,
            overflow: "hidden",
          }}
        >
          <HslSphereScene
            mainCameraRef={sceneRef}
            axisConvention={axisConvention}
            compact={compact}
            visible={visible}
            onOrientationSnapshot={onOrientationSnapshot}
          />
        </Canvas>
      ) : null}
    </div>
  );
}

/* ── Inner scene (must be inside Canvas) ───────────────────── */

function HslSphereScene({
  mainCameraRef,
  axisConvention,
  compact,
  visible,
  onOrientationSnapshot,
}: {
  mainCameraRef: MutableRefObject<{ camera: THREE.Camera } | null>;
  axisConvention: AxisConvention;
  compact: boolean;
  visible: boolean;
  onOrientationSnapshot?: (snapshot: OrientationDebugSnapshot) => void;
}) {
  const glowGeo = useMemo(
    () => new THREE.SphereGeometry(SPHERE_RADIUS * 1.06, SEGMENTS, SEGMENTS),
    [],
  );
  const sphereGeo = useMemo(() => {
    const geo = new THREE.SphereGeometry(SPHERE_RADIUS, SEGMENTS, SEGMENTS);
    const posAttr = geo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);
    const v = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();
      const [mx, my, mz] = applyAxisConventionVec3([v.x, v.y, v.z], axisConvention);
      const c = magnetizationHslColor(mx, my, mz);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [axisConvention]);
  const sphereMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true }),
    [],
  );
  const glowMat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: "#8fd8ff",
      transparent: true,
      opacity: compact ? 0.06 : 0.09,
      side: THREE.BackSide,
      depthWrite: false,
    }),
    [compact],
  );
  const shellMat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: "#dff3ff",
      wireframe: true,
      transparent: true,
      opacity: compact ? 0.1 : 0.14,
      depthWrite: false,
    }),
    [compact],
  );
  useEffect(() => {
    return () => {
      glowGeo.dispose();
      sphereGeo.dispose();
      glowMat.dispose();
      shellMat.dispose();
      sphereMat.dispose();
    };
  }, [glowGeo, glowMat, shellMat, sphereGeo, sphereMat]);
  const axisLabels = {
    screenX: sceneAxisDescriptor(0, axisConvention),
    screenY: sceneAxisDescriptor(1, axisConvention),
    depth: sceneAxisDescriptor(2, axisConvention),
  };

  return (
    <>
      <CameraSync mainCameraRef={mainCameraRef} onOrientationSnapshot={onOrientationSnapshot} />
      <CanvasVisibilityInvalidator visible={visible} />

      <mesh geometry={glowGeo} material={glowMat} />

      {/* Vertex-coloured sphere */}
      <mesh geometry={sphereGeo} material={sphereMat} />
      <mesh geometry={sphereGeo} material={shellMat} />

      {/* Axis labels — visual XYZ reference for the active viewport convention */}
      {(() => {
        const fs = compact ? 0.30 : 0.38;
        const ld = compact ? 1.12 : 1.26;
        return (
          <>
            <AxisLabel text={`+${axisLabels.screenX.text}`} color={axisLabels.screenX.color} position={[ld, 0, 0]} fontSize={fs} />
            <AxisLabel text={`-${axisLabels.screenX.text}`} color={axisLabels.screenX.color} position={[-ld, 0, 0]} fontSize={fs} />
            <AxisLabel text={`+${axisLabels.screenY.text}`} color={axisLabels.screenY.color} position={[0, ld, 0]} fontSize={fs} />
            <AxisLabel text={`-${axisLabels.screenY.text}`} color={axisLabels.screenY.color} position={[0, -ld, 0]} fontSize={fs} />
            <AxisLabel text={`+${axisLabels.depth.text}`} color={axisLabels.depth.color} position={[0, 0, ld]} fontSize={fs} />
            <AxisLabel text={`-${axisLabels.depth.text}`} color={axisLabels.depth.color} position={[0, 0, -ld]} fontSize={fs} />
          </>
        );
      })()}

      {/* Thin axis lines through sphere */}
      <Line
        points={[[-1.12, 0, 0], [1.12, 0, 0]]}
        color={axisLabels.screenX.color}
        lineWidth={1.4}
        transparent
        opacity={0.72}
      />
      <Line
        points={[[0, -1.12, 0], [0, 1.12, 0]]}
        color={axisLabels.screenY.color}
        lineWidth={1.4}
        transparent
        opacity={0.72}
      />
      <Line
        points={[[0, 0, -1.12], [0, 0, 1.12]]}
        color={axisLabels.depth.color}
        lineWidth={1.4}
        transparent
        opacity={0.72}
      />
    </>
  );
}
