"use client";

import {
  GizmoViewcube,
  Line,
} from "@react-three/drei";
import {
  useFrame,
  useThree,
  type ThreeEvent,
} from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  BufferAttribute,
  CanvasTexture,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Group,
} from "three";

import { viewport3dStore } from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";

import {
  snapCameraToDirection,
  type Direction3,
} from "./cameraOrientation";
import { resolveOrientationHudAnchors } from "./hudLayout";
import {
  HSL_REFERENCE_AXES,
  magnetizationHslRgb,
} from "./magnetizationColor";

interface OrientationHudLayerProps {
  colors: Viewport3DColors;
  hslReferenceVisible: boolean;
  viewCubeVisible: boolean;
}

type OrbitControlsHandle = {
  target?: Vector3;
  update?: (delta?: number) => void;
};

interface AnchorVectors {
  center: Vector3;
  forward: Vector3;
  position: Vector3;
  right: Vector3;
  up: Vector3;
}

const WIDGET_CAMERA_DISTANCE = 2;
const WIDGET_RENDER_ORDER = 10_000;

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
        <ScreenAnchoredGroup anchor="viewCube" pixelScale={1.15}>
          <ViewCube3DBox colors={colors} onSnap={snapToDirection} />
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
  }, [invalidate]);

  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const anchors = resolveOrientationHudAnchors(size);
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
      <mesh geometry={geometry} renderOrder={WIDGET_RENDER_ORDER}>
        <meshBasicMaterial
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
          vertexColors
        />
      </mesh>
      <HslReferenceAxes colors={colors} />
      <mesh renderOrder={WIDGET_RENDER_ORDER + 1}>
        <sphereGeometry args={[1.012, 20, 12]} />
        <meshBasicMaterial
          color={colors.wire}
          depthTest={false}
          depthWrite={false}
          opacity={0.24}
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
              lineWidth={4}
              opacity={0.45}
              points={[[0, 0, 0], end]}
              renderOrder={WIDGET_RENDER_ORDER + 2}
              transparent
            />
            <Line
              color={axisColor}
              depthTest={false}
              lineWidth={2}
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

function AxisLabelSprite({
  color,
  label,
  outlineColor,
  position,
}: {
  color: string;
  label: string;
  outlineColor: string;
  position: [number, number, number];
}) {
  const texture = useMemo(
    () => buildAxisLabelTexture(label, color, outlineColor),
    [color, label, outlineColor],
  );

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite
      position={position}
      renderOrder={WIDGET_RENDER_ORDER + 5}
      scale={[0.46, 0.22, 1]}
    >
      <spriteMaterial
        depthTest={false}
        depthWrite={false}
        map={texture}
        toneMapped={false}
        transparent
      />
    </sprite>
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

function buildAxisLabelTexture(
  label: string,
  color: string,
  outlineColor: string,
): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = "700 32px Inter, Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 7;
    context.strokeStyle = outlineColor;
    context.fillStyle = color;
    context.strokeText(label, 64, 34);
    context.fillText(label, 64, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function updateScreenAnchor(
  group: Group,
  camera: Camera,
  size: { height: number; width: number },
  anchor: readonly [number, number, number],
  vectors: AnchorVectors,
): number {
  const distance = Math.max(WIDGET_CAMERA_DISTANCE, cameraNear(camera) + 0.1);
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
