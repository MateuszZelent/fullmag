"use client";

import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  BackSide,
  BufferAttribute,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Group,
} from "three";

import { viewport3dStore } from "../viewport3dStore";
import type {
  Viewport3DCameraState,
  Viewport3DRotationMode,
} from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  freeCameraTargetForDirection,
  orbitCameraAroundTarget,
  rotateFreeCameraTarget,
  resolveViewCubeCurrentCameraState,
  snapCameraToDirection,
  type Direction3,
} from "./cameraOrientation";
import { resolveOrientationHudAnchors } from "./hudLayout";
import {
  HSL_REFERENCE_AXES,
  magnetizationHslRgb,
} from "./magnetizationColor";
import {
  ORBIT_SENSITIVITY,
  WIDGET_CAMERA_DISTANCE,
  WIDGET_RENDER_ORDER,
} from "./orientationHudConstants";
import { AxisLabelSprite } from "./AxisLabelSprite";
import { ViewCube3DBox, type OrbitControlsHandle } from "./ViewCube3DBox";

interface OrientationHudLayerProps {
  colors: Viewport3DColors;
  hslReferenceVisible: boolean;
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
  rotationMode: Viewport3DRotationMode;
  viewCubeVisible: boolean;
}

interface AnchorVectors {
  center: Vector3;
  forward: Vector3;
  position: Vector3;
  right: Vector3;
  up: Vector3;
}

export function OrientationHudLayer({
  colors,
  hslReferenceVisible,
  onCameraChange,
  rotationMode,
  viewCubeVisible,
}: OrientationHudLayerProps) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const controls = useThree((state) =>
    "controls" in state ? (state.controls as OrbitControlsHandle | undefined) : undefined,
  );
  const pendingOrbitCameraRef = useRef<Viewport3DCameraState | null>(null);
  const commitCameraChange = useCallback(
    (nextCamera: Viewport3DCameraState) => {
      void Promise.resolve(onCameraChange(nextCamera)).catch(() => undefined);
    },
    [onCameraChange],
  );
  const getCurrentCamera = useCallback(
    () =>
      resolveViewCubeCurrentCameraState({
        cameraPosition: camera.position.toArray() as [number, number, number],
        cameraState: viewport3dStore.getSnapshot().camera,
        cameraUp: camera.up.toArray() as [number, number, number],
        controlsTarget: controls?.target?.toArray() as
          | [number, number, number]
          | undefined,
      }),
    [camera, controls],
  );
  const snapToDirection = useCallback(
    (direction: Direction3) => {
      const currentCamera = getCurrentCamera();
      const nextCamera = {
        ...(rotationMode === "camera"
          ? freeCameraTargetForDirection(currentCamera, direction)
          : snapCameraToDirection(currentCamera, direction)),
      };

      camera.up.set(...nextCamera.up);
      camera.position.set(...nextCamera.position);
      camera.lookAt(...nextCamera.target);
      camera.updateProjectionMatrix();
      controls?.target?.set(...nextCamera.target);
      controls?.update?.();
      viewport3dStore.setCamera(nextCamera);
      commitCameraChange(nextCamera);
      invalidate();
    },
    [camera, commitCameraChange, controls, getCurrentCamera, invalidate, rotationMode],
  );

  const onOrbit = useCallback(
    (deltaX: number) => {
      const currentCamera = getCurrentCamera();
      const nextCamera = {
        ...(rotationMode === "camera"
          ? rotateFreeCameraTarget(currentCamera, deltaX, ORBIT_SENSITIVITY)
          : orbitCameraAroundTarget(currentCamera, deltaX, ORBIT_SENSITIVITY)),
      };

      camera.up.set(...nextCamera.up);
      camera.position.set(nextCamera.position[0], nextCamera.position[1], nextCamera.position[2]);
      camera.lookAt(nextCamera.target[0], nextCamera.target[1], nextCamera.target[2]);
      camera.updateProjectionMatrix();
      controls?.target?.set(nextCamera.target[0], nextCamera.target[1], nextCamera.target[2]);
      controls?.update?.();
      viewport3dStore.setCamera(nextCamera);
      pendingOrbitCameraRef.current = nextCamera;
      invalidate();
    },
    [camera, controls, getCurrentCamera, invalidate, rotationMode],
  );
  const commitOrbit = useCallback(() => {
    const nextCamera = pendingOrbitCameraRef.current;
    if (!nextCamera) return;
    pendingOrbitCameraRef.current = null;
    commitCameraChange(nextCamera);
  }, [commitCameraChange]);

  if (!viewCubeVisible && !hslReferenceVisible) {
    return null;
  }

  return (
    <>
      {viewCubeVisible ? (
        <ScreenAnchoredGroup anchor="viewCube" pixelScale={1.15}>
          <ViewCube3DBox
            colors={colors}
            controls={controls}
            onOrbit={onOrbit}
            onOrbitEnd={commitOrbit}
            onSnap={snapToDirection}
          />
        </ScreenAnchoredGroup>
      ) : null}
      {hslReferenceVisible ? (
        <ScreenAnchoredGroup anchor="hslReference" pixelScale={1}>
          <HslReferenceSphere colors={colors} />
        </ScreenAnchoredGroup>
      ) : null}
    </>
  );
}

function ScreenAnchoredGroup({
  anchor,
  children,
  pixelScale,
}: {
  anchor: keyof ReturnType<typeof resolveOrientationHudAnchors>;
  children: ReactNode;
  pixelScale: number;
}) {
  const ref = useRef<Group>(null);
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const size = useThree((state) => state.size);
  const anchors = useMemo(() => resolveOrientationHudAnchors(size), [size]);
  const vectors = useMemo<AnchorVectors>(
    () => ({
      center: new Vector3(),
      forward: new Vector3(),
      position: new Vector3(),
      right: new Vector3(),
      up: new Vector3(),
    }),
    [],
  );

  useEffect(() => {
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const worldPerPixel = updateScreenAnchor(
      group,
      camera,
      size,
      anchors[anchor],
      vectors,
    );
    group.scale.setScalar(worldPerPixel * pixelScale);
    group.visible = true;
  });

  return (
    <group
      ref={ref}
      renderOrder={WIDGET_RENDER_ORDER}
      scale={[0, 0, 0]}
      visible={false}
    >
      {children}
    </group>
  );
}

function HslReferenceSphere({ colors }: { colors: Viewport3DColors }) {
  const geometry = useMemo(() => buildHslSphereGeometry(), []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group scale={[40, 40, 40]}>
      {/* Soft glow halo — BackSide sphere slightly larger */}
      <mesh renderOrder={WIDGET_RENDER_ORDER - 1}>
        <sphereGeometry args={[1.09, 32, 18]} />
        <meshBasicMaterial
          color={colors.accentStrong ?? colors.accent}
          depthTest={false}
          depthWrite={false}
          opacity={0.07}
          side={BackSide}
          toneMapped={false}
          transparent
        />
      </mesh>
      {/* Vertex-coloured HSL sphere */}
      <mesh geometry={geometry} renderOrder={WIDGET_RENDER_ORDER}>
        <meshBasicMaterial
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
          vertexColors
        />
      </mesh>
      <HslReferenceAxes colors={colors} />
      {/* Wireframe overlay */}
      <mesh renderOrder={WIDGET_RENDER_ORDER + 1}>
        <sphereGeometry args={[1.015, 32, 18]} />
        <meshBasicMaterial
          color={colors.wire}
          depthTest={false}
          depthWrite={false}
          opacity={0.18}
          transparent
          wireframe
        />
      </mesh>
    </group>
  );
}

function HslReferenceAxes({ colors }: { colors: Viewport3DColors }) {
  return (
    <group>
      {HSL_REFERENCE_AXES.map((axis) => {
        const axisColor = rgbCss(axis.color);
        const end = scaleDirection(axis.direction, 1.42);
        const tip = scaleDirection(axis.direction, 1.52);
        const label = scaleDirection(axis.direction, 1.78);

        return (
          <group key={axis.id}>
            <Line
              color={String(colors.wire)}
              depthTest={false}
              lineWidth={5}
              opacity={0.55}
              points={[[0, 0, 0], end]}
              renderOrder={WIDGET_RENDER_ORDER + 2}
              transparent
            />
            <Line
              color={axisColor}
              depthTest={false}
              lineWidth={2.5}
              points={[[0, 0, 0], end]}
              renderOrder={WIDGET_RENDER_ORDER + 3}
            />
            <mesh
              position={tip}
              renderOrder={WIDGET_RENDER_ORDER + 4}
              rotation={axisTipRotation(axis.id)}
            >
              <coneGeometry args={[0.06, 0.16, 16]} />
              <meshBasicMaterial
                color={axisColor}
                depthTest={false}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <AxisLabelSprite
              color={axisColor}
              label={axis.label}
              outlineColor={String(colors.wire)}
              position={label}
            />
          </group>
        );
      })}
    </group>
  );
}

function buildHslSphereGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(1, 40, 24);
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);

  for (let index = 0; index < position.count; index += 1) {
    const [red, green, blue] = magnetizationHslRgb(
      position.getX(index),
      position.getY(index),
      position.getZ(index),
    );
    const offset = index * 3;
    colors[offset] = red;
    colors[offset + 1] = green;
    colors[offset + 2] = blue;
  }

  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

function updateScreenAnchor(
  group: Group,
  camera: Camera,
  size: { height: number; width: number },
  anchor: readonly [number, number, number],
  vectors: AnchorVectors,
): number {
  const near = cameraNear(camera);
  const far = cameraFar(camera);
  // Place the widget at 90% of far — leaving 10% depth headroom for the
  // orbit ring, axis labels, and cube faces that extend behind the anchor.
  const distance = Math.min(far * 0.90, Math.max(WIDGET_CAMERA_DISTANCE, near * 10));
  const worldHeight = visibleWorldHeight(camera, distance);
  const worldWidth = worldHeight * (size.width / Math.max(size.height, 1));
  const worldPerPixel = worldHeight / Math.max(size.height, 1);

  vectors.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  vectors.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  vectors.forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
  vectors.center.copy(camera.position).addScaledVector(vectors.forward, distance);
  vectors.position
    .copy(vectors.center)
    .addScaledVector(vectors.right, (anchor[0] / Math.max(size.width, 1)) * worldWidth)
    .addScaledVector(vectors.up, (anchor[1] / Math.max(size.height, 1)) * worldHeight);

  group.position.copy(vectors.position);
  return worldPerPixel;
}

function cameraNear(camera: Camera): number {
  const near = (camera as { near?: unknown }).near;
  return typeof near === "number" ? near : 0.1;
}

function cameraFar(camera: Camera): number {
  const far = (camera as { far?: unknown }).far;
  return typeof far === "number" ? far : 1000;
}

function visibleWorldHeight(camera: Camera, distance: number): number {
  if ("isOrthographicCamera" in camera && camera.isOrthographicCamera) {
    const orthographicCamera = camera as {
      bottom?: unknown;
      top?: unknown;
      zoom?: unknown;
    };
    const top = Number(orthographicCamera.top ?? 1);
    const bottom = Number(orthographicCamera.bottom ?? -1);
    const zoom = Number(orthographicCamera.zoom ?? 1) || 1;
    return Math.abs(top - bottom) / zoom;
  }

  const fov = Number((camera as { fov?: unknown }).fov ?? 42);
  return 2 * Math.tan((fov * Math.PI) / 360) * distance;
}

function scaleDirection(
  direction: readonly [number, number, number],
  scale: number,
): [number, number, number] {
  return [
    direction[0] * scale,
    direction[1] * scale,
    direction[2] * scale,
  ];
}

function rgbCss([red, green, blue]: readonly [number, number, number]): string {
  return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(
    blue * 255,
  )})`;
}

function axisTipRotation(axisId: string): [number, number, number] {
  if (axisId === "x") return [0, 0, -Math.PI / 2];
  if (axisId === "z") return [Math.PI / 2, 0, 0];
  return [0, 0, 0];
}
