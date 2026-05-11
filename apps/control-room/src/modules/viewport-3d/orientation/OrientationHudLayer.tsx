"use client";

import { GizmoHelper, GizmoViewcube } from "@react-three/drei";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo } from "react";
import {
  BufferAttribute,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from "three";

import { viewport3dStore } from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";

import { magnetizationHslRgb } from "./magnetizationColor";
import {
  snapCameraToDirection,
  type Direction3,
} from "./cameraOrientation";

interface OrientationHudLayerProps {
  colors: Viewport3DColors;
  hslReferenceVisible: boolean;
  viewCubeVisible: boolean;
}

type OrbitControlsHandle = {
  target?: Vector3;
  update?: (delta?: number) => void;
};

export function OrientationHudLayer({
  colors,
  hslReferenceVisible,
  viewCubeVisible,
}: OrientationHudLayerProps) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const controls = useThree((state) =>
    "controls" in state ? (state.controls as OrbitControlsHandle | undefined) : undefined,
  );
  const getTarget = useCallback(
    () => controls?.target?.clone() ?? new Vector3(0, 0, 0),
    [controls],
  );
  const handleCameraUpdate = useCallback(() => {
    const target = getTarget();
    viewport3dStore.setCamera({
      position: camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
    });
    invalidate();
  }, [camera, getTarget, invalidate]);
  const snapToDirection = useCallback(
    (direction: Direction3) => {
      const target = getTarget();
      const nextCamera = snapCameraToDirection(
        {
          position: camera.position.toArray() as [number, number, number],
          target: target.toArray() as [number, number, number],
        },
        direction,
      );

      camera.position.set(...nextCamera.position);
      camera.lookAt(...nextCamera.target);
      camera.updateProjectionMatrix();
      controls?.target?.set(...nextCamera.target);
      controls?.update?.();
      viewport3dStore.setCamera(nextCamera);
      invalidate();
    },
    [camera, controls, getTarget, invalidate],
  );

  if (!viewCubeVisible && !hslReferenceVisible) {
    return null;
  }

  return (
    <>
      {viewCubeVisible ? (
        <GizmoHelper
          alignment="top-right"
          margin={[86, 86]}
          onTarget={getTarget}
          onUpdate={handleCameraUpdate}
          renderPriority={2}
        >
          <ViewCube3DBox colors={colors} onSnap={snapToDirection} />
        </GizmoHelper>
      ) : null}
      {hslReferenceVisible ? (
        <GizmoHelper
          alignment="top-right"
          margin={[86, viewCubeVisible ? 182 : 86]}
          onTarget={getTarget}
          renderPriority={3}
        >
          <HslReferenceSphere colors={colors} />
        </GizmoHelper>
      ) : null}
    </>
  );
}

export function ViewCube3DBox({
  colors,
  onSnap,
}: {
  colors: Viewport3DColors;
  onSnap: (direction: Direction3) => void;
}) {
  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const direction = directionFromViewCubeEvent(event);
      if (direction) {
        onSnap(direction);
      }
      return null;
    },
    [onSnap],
  );

  return (
    <GizmoViewcube
      color={String(colors.mesh)}
      faces={["Right", "Left", "Top", "Bottom", "Front", "Back"]}
      hoverColor={String(colors.accent)}
      onClick={handleClick}
      opacity={0.94}
      strokeColor={String(colors.wire)}
      textColor={String(colors.field)}
    />
  );
}

function directionFromViewCubeEvent(
  event: ThreeEvent<MouseEvent>,
): Direction3 | null {
  const objectPosition = event.object.position;
  if (objectPosition.lengthSq() > 0) {
    return [
      Math.sign(objectPosition.x),
      Math.sign(objectPosition.y),
      Math.sign(objectPosition.z),
    ];
  }

  const normal = event.face?.normal;
  if (!normal) {
    return null;
  }

  return [
    Math.sign(normal.x),
    Math.sign(normal.y),
    Math.sign(normal.z),
  ];
}

export function HslReferenceSphere({ colors }: { colors: Viewport3DColors }) {
  const geometry = useMemo(() => buildHslSphereGeometry(), []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group scale={[38, 38, 38]}>
      <mesh geometry={geometry}>
        <meshBasicMaterial toneMapped={false} vertexColors />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.012, 20, 12]} />
        <meshBasicMaterial
          color={colors.wire}
          opacity={0.24}
          transparent
          wireframe
        />
      </mesh>
    </group>
  );
}

function buildHslSphereGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(1, 40, 24);
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);

  for (let index = 0; index < position.count; index += 1) {
    const [r, g, b] = magnetizationHslRgb(
      position.getX(index),
      position.getY(index),
      position.getZ(index),
    );
    const offset = index * 3;
    colors[offset] = r;
    colors[offset + 1] = g;
    colors[offset + 2] = b;
  }

  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}
