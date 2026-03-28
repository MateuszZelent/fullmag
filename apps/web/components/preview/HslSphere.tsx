"use client";

/**
 * HSL Colour Sphere – R3F version.
 *
 * A small inset 3D colour reference that rotates in sync with the main
 * viewport camera. The sphere surface uses the exact same magnetizationHSL
 * colour mapping as arrow/voxel rendering.
 *
 * Axis labels (X / Y / Z) protrude from the sphere following the simulation
 * coordinate convention (sim-Z → scene-Y, sim-Y → scene-Z).
 */

import { useRef, useMemo, useEffect } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Text, Billboard, Line } from "@react-three/drei";
import { magnetizationHslColor } from "./magnetizationColor";

/* ── Types ─────────────────────────────────────────────────── */

interface HslSphereProps {
  sceneRef: React.MutableRefObject<{
    camera: THREE.PerspectiveCamera | THREE.Camera;
    controls: any;
  } | null>;
}

/* ── Constants ─────────────────────────────────────────────── */

const SIZE = 110;
const SPHERE_RADIUS = 0.9;
const SEGMENTS = 64;
const LABEL_DIST = 1.18;

/* ── Vertex-coloured sphere geometry (memoized) ───────────── */

function useColoredSphereGeometry() {
  return useMemo(() => {
    const geo = new THREE.SphereGeometry(SPHERE_RADIUS, SEGMENTS, SEGMENTS);
    const posAttr = geo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);
    const _v = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      _v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();
      // Simulation convention: world (x, y, z) → sim (x, z, y)
      const c = magnetizationHslColor(_v.x, _v.z, _v.y);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, []);
}

/* ── Axis label component ─────────────────────────────────── */

function AxisLabel({ text, color, position }: {
  text: string;
  color: string;
  position: [number, number, number];
}) {
  return (
    <Billboard position={position}>
      <Text
        fontSize={0.28}
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
  mainCameraRef: React.MutableRefObject<{ camera: THREE.Camera } | null>;
}) {
  const { camera } = useThree();

  useFrame(() => {
    const main = mainCameraRef.current;
    if (!main) return;

    // Copy only the rotation from the main camera
    camera.quaternion.copy(main.camera.quaternion);
    camera.position.set(0, 0, 3).applyQuaternion(camera.quaternion);
    camera.lookAt(0, 0, 0);
  });

  return null;
}

/* ── Component ─────────────────────────────────────────────── */

export default function HslSphere({ sceneRef }: HslSphereProps) {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 h-[110px] w-[110px]">
      <Canvas
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
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          overflow: "hidden",
        }}
      >
        <HslSphereScene mainCameraRef={sceneRef} />
      </Canvas>
    </div>
  );
}

/* ── Inner scene (must be inside Canvas) ───────────────────── */

function HslSphereScene({
  mainCameraRef,
}: {
  mainCameraRef: React.MutableRefObject<{ camera: THREE.Camera } | null>;
}) {
  const sphereGeo = useColoredSphereGeometry();
  const sphereMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true }),
    [],
  );

  return (
    <>
      <CameraSync mainCameraRef={mainCameraRef} />

      {/* Vertex-coloured sphere */}
      <mesh geometry={sphereGeo} material={sphereMat} />

      {/* Axis labels — sim convention: scene-Y=sim-Z, scene-Z=sim-Y */}
      <AxisLabel text="X" color="#e65050" position={[LABEL_DIST, 0, 0]} />
      <AxisLabel text="X" color="#e65050" position={[-LABEL_DIST, 0, 0]} />
      <AxisLabel text="Z" color="#5090e6" position={[0, LABEL_DIST, 0]} />
      <AxisLabel text="Z" color="#5090e6" position={[0, -LABEL_DIST, 0]} />
      <AxisLabel text="Y" color="#50c850" position={[0, 0, LABEL_DIST]} />
      <AxisLabel text="Y" color="#50c850" position={[0, 0, -LABEL_DIST]} />

      {/* Thin axis lines through sphere */}
      <Line
        points={[[-1.05, 0, 0], [1.05, 0, 0]]}
        color="#e65050"
        lineWidth={1}
        transparent
        opacity={0.5}
      />
      <Line
        points={[[0, -1.05, 0], [0, 1.05, 0]]}
        color="#5090e6"
        lineWidth={1}
        transparent
        opacity={0.5}
      />
      <Line
        points={[[0, 0, -1.05], [0, 0, 1.05]]}
        color="#50c850"
        lineWidth={1}
        transparent
        opacity={0.5}
      />
    </>
  );
}
