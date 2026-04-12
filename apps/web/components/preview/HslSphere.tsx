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

import { useCallback, useEffect, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { Text, Billboard, Line } from "@react-three/drei";
import { magnetizationHslColor } from "./magnetizationColor";
import { cn } from "@/lib/utils";
import { useCanvasHost } from "./shared/useCanvasHost";

/* ── Types ─────────────────────────────────────────────────── */

interface HslSphereProps {
  sceneRef: React.MutableRefObject<{
    camera: THREE.PerspectiveCamera | THREE.Camera;
    controls: any;
  } | null>;
  axisConvention?: "identity" | "swapYZ";
  size?: number;
  compact?: boolean;
  className?: string;
  anchorClassName?: string;
  embedded?: boolean;
}

/* ── Constants ─────────────────────────────────────────────── */

const SIZE = 110;
const SPHERE_RADIUS = 0.9;
const SEGMENTS = 64;
const LABEL_DIST = 1.18;

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
}: {
  mainCameraRef: React.MutableRefObject<{ camera: THREE.Camera; controls?: any } | null>;
}) {
  const { camera, invalidate } = useThree();
  const syncCamera = useCallback(() => {
    const main = mainCameraRef.current;
    if (!main) {
      return;
    }
    // Copy only the rotation from the main camera.
    camera.quaternion.copy(main.camera.quaternion);
    camera.position.set(0, 0, 3).applyQuaternion(camera.quaternion);
    camera.lookAt(0, 0, 0);
    invalidate();
  }, [camera, invalidate, mainCameraRef]);

  useEffect(() => {
    let frameId: number | null = null;
    const lastQuaternion = new THREE.Quaternion();
    let initialized = false;
    const tick = () => {
      const main = mainCameraRef.current;
      if (main) {
        if (!initialized || !lastQuaternion.equals(main.camera.quaternion)) {
          lastQuaternion.copy(main.camera.quaternion);
          initialized = true;
          syncCamera();
        }
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [mainCameraRef, syncCamera]);

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
}: HslSphereProps) {
  const sphereSize = compact ? Math.round(size * 0.82) : size;
  const { hostRef, hostNode } = useCanvasHost<HTMLDivElement>();
  return (
    <div
      ref={hostRef}
      className={cn(
        "pointer-events-none relative",
        embedded ? "self-start" : null,
        anchorClassName,
        className,
      )}
      style={{ width: sphereSize, height: sphereSize }}
    >
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
            borderRadius: "50%",
            overflow: "hidden",
          }}
        >
          <HslSphereScene
            mainCameraRef={sceneRef}
            axisConvention={axisConvention}
            compact={compact}
          />
        </Canvas>
      ) : null}
    </div>
  );
}

/* ── Inner scene (must be inside Canvas) ───────────────────── */

type AxisConvention = "identity" | "swapYZ";

function conventionVector(
  x: number,
  y: number,
  z: number,
  axisConvention: AxisConvention,
): [number, number, number] {
  if (axisConvention === "swapYZ") {
    return [x, z, y];
  }
  return [x, y, z];
}

function HslSphereScene({
  mainCameraRef,
  axisConvention,
  compact,
}: {
  mainCameraRef: React.MutableRefObject<{ camera: THREE.Camera } | null>;
  axisConvention: AxisConvention;
  compact: boolean;
}) {
  const sphereGeo = useMemo(() => {
    const geo = new THREE.SphereGeometry(SPHERE_RADIUS, SEGMENTS, SEGMENTS);
    const posAttr = geo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);
    const v = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();
      const [mx, my, mz] = conventionVector(v.x, v.y, v.z, axisConvention);
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
  useEffect(() => {
    return () => {
      sphereGeo.dispose();
      sphereMat.dispose();
    };
  }, [sphereGeo, sphereMat]);
  const axisLabels =
    axisConvention === "swapYZ"
      ? {
          screenX: { text: "X", color: "#e65050" },
          screenY: { text: "Z", color: "#5090e6" },
          depth: { text: "Y", color: "#50c850" },
        }
      : {
          screenX: { text: "X", color: "#e65050" },
          screenY: { text: "Y", color: "#50c850" },
          depth: { text: "Z", color: "#5090e6" },
        };

  return (
    <>
      <CameraSync mainCameraRef={mainCameraRef} />

      {/* Vertex-coloured sphere */}
      <mesh geometry={sphereGeo} material={sphereMat} />

      {/* Axis labels — visual XYZ reference for the active viewport convention */}
      {(() => {
        const fs = compact ? 0.20 : 0.28;
        const ld = compact ? 1.08 : LABEL_DIST;
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
        points={[[-1.05, 0, 0], [1.05, 0, 0]]}
        color={axisLabels.screenX.color}
        lineWidth={1}
        transparent
        opacity={0.5}
      />
      <Line
        points={[[0, -1.05, 0], [0, 1.05, 0]]}
        color={axisLabels.screenY.color}
        lineWidth={1}
        transparent
        opacity={0.5}
      />
      <Line
        points={[[0, 0, -1.05], [0, 0, 1.05]]}
        color={axisLabels.depth.color}
        lineWidth={1}
        transparent
        opacity={0.5}
      />
    </>
  );
}
