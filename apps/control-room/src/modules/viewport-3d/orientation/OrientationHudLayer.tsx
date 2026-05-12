"use client";

import { Line } from "@react-three/drei";
import {
  useFrame,
  useThree,
} from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BackSide,
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
import {
  buildViewCubeFaces,
  getViewCubeAxisLabels,
  resolveViewCubeTargetCell,
  type ViewCubeFaceModel,
  type ViewCubeTargetKind,
} from "./viewCubeModel";

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
const VIEW_CUBE_HALF = 31;
const VIEW_CUBE_FACE_SIZE = VIEW_CUBE_HALF * 2;
const VIEW_CUBE_EDGE_SIZE = 10;
const VIEW_CUBE_LABEL_DISTANCE = 49;
const VIEW_CUBE_EDGE_POINTS = buildViewCubeEdgePoints(VIEW_CUBE_HALF);
const VIEW_CUBE_FACE_GRID_POINTS = buildViewCubeFaceGridPoints(
  VIEW_CUBE_HALF,
  VIEW_CUBE_EDGE_SIZE,
);
const VIEW_CUBE_AXIS_COLORS = {
  x: "#e65050",
  y: "#50c850",
  z: "#5090e6",
};
const VIEW_CUBE_FACE_PLACEMENTS: Record<ViewCubeFaceModel["id"], {
  accent: string;
  position: [number, number, number];
  rotation: [number, number, number];
}> = {
  right: {
    accent: VIEW_CUBE_AXIS_COLORS.x,
    position: [VIEW_CUBE_HALF, 0, 0],
    rotation: [0, Math.PI / 2, 0],
  },
  left: {
    accent: VIEW_CUBE_AXIS_COLORS.x,
    position: [-VIEW_CUBE_HALF, 0, 0],
    rotation: [0, -Math.PI / 2, 0],
  },
  top: {
    accent: VIEW_CUBE_AXIS_COLORS.y,
    position: [0, VIEW_CUBE_HALF, 0],
    rotation: [-Math.PI / 2, 0, 0],
  },
  bottom: {
    accent: VIEW_CUBE_AXIS_COLORS.y,
    position: [0, -VIEW_CUBE_HALF, 0],
    rotation: [Math.PI / 2, 0, 0],
  },
  front: {
    accent: VIEW_CUBE_AXIS_COLORS.z,
    position: [0, 0, VIEW_CUBE_HALF],
    rotation: [0, 0, 0],
  },
  back: {
    accent: VIEW_CUBE_AXIS_COLORS.z,
    position: [0, 0, -VIEW_CUBE_HALF],
    rotation: [0, Math.PI, 0],
  },
};

const VIEW_CUBE_FACE_LABELS: Record<ViewCubeFaceModel["id"], string> = {
  right: "RIGHT",
  left: "LEFT",
  top: "TOP",
  bottom: "BOTTOM",
  front: "FRONT",
  back: "BACK",
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const axisLabels = getViewCubeAxisLabels();
  const faces = useMemo(() => buildViewCubeFaces(), []);

  return (
    <group>
      {/* Solid dark cube body */}
      <mesh renderOrder={WIDGET_RENDER_ORDER}>
        <boxGeometry
          args={[
            VIEW_CUBE_FACE_SIZE,
            VIEW_CUBE_FACE_SIZE,
            VIEW_CUBE_FACE_SIZE,
          ]}
        />
        <meshBasicMaterial
          color="#0a0e16"
          depthTest={false}
          depthWrite={false}
          opacity={0.64}
          toneMapped={false}
          transparent
        />
      </mesh>
      {faces.map((face) => {
        const faceHovered = hoveredTargetId?.startsWith(`${face.id}:`) ?? false;
        return (
          <ViewCubeFacePanel
            key={face.id}
            colors={colors}
            face={face}
            faceHovered={faceHovered}
            hoveredTargetId={hoveredTargetId}
            onHoverChange={setHoveredTargetId}
            onSnap={onSnap}
          />
        );
      })}
      {/* Bright cube edges */}
      {VIEW_CUBE_EDGE_POINTS.map((edge) => (
        <Line
          key={viewCubeSegmentKey(edge)}
          color={String(colors.wire)}
          depthTest={false}
          lineWidth={3.2}
          opacity={0.88}
          points={edge}
          renderOrder={WIDGET_RENDER_ORDER + 2}
          transparent
        />
      ))}
      <AxisLabelSprite
        color={VIEW_CUBE_AXIS_COLORS.x}
        label={trimPositiveAxisLabel(axisLabels.x)}
        outlineColor={String(colors.background)}
        position={[VIEW_CUBE_LABEL_DISTANCE, 0, 0]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
      <AxisLabelSprite
        color={VIEW_CUBE_AXIS_COLORS.y}
        label={trimPositiveAxisLabel(axisLabels.y)}
        outlineColor={String(colors.background)}
        position={[0, VIEW_CUBE_LABEL_DISTANCE, 0]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
      <AxisLabelSprite
        color={VIEW_CUBE_AXIS_COLORS.z}
        label={trimPositiveAxisLabel(axisLabels.z)}
        outlineColor={String(colors.background)}
        position={[0, 0, VIEW_CUBE_LABEL_DISTANCE]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
    </group>
  );
}

function ViewCubeFacePanel({
  colors,
  face,
  faceHovered,
  hoveredTargetId,
  onHoverChange,
  onSnap,
}: {
  colors: Viewport3DColors;
  face: ViewCubeFaceModel;
  faceHovered: boolean;
  hoveredTargetId: string | null;
  onHoverChange: (id: string | null) => void;
  onSnap: (direction: Direction3) => void;
}) {
  const placement = VIEW_CUBE_FACE_PLACEMENTS[face.id];
  const label = VIEW_CUBE_FACE_LABELS[face.id];

  const normalTexture = useMemo(
    () => buildViewCubeFaceTexture(label, placement.accent, false),
    [label, placement.accent],
  );
  const hoveredTexture = useMemo(
    () => buildViewCubeFaceTexture(label, placement.accent, true),
    [label, placement.accent],
  );

  useEffect(
    () => () => {
      normalTexture.dispose();
      hoveredTexture.dispose();
    },
    [normalTexture, hoveredTexture],
  );

  return (
    <group position={placement.position} rotation={placement.rotation}>
      {/* Recessed volumetric panel behind the visible 3x3 target grid. */}
      <mesh renderOrder={WIDGET_RENDER_ORDER + 1}>
        <planeGeometry args={[VIEW_CUBE_FACE_SIZE, VIEW_CUBE_FACE_SIZE]} />
        <meshBasicMaterial
          color="#0f1724"
          depthTest={false}
          depthWrite={false}
          opacity={faceHovered ? 0.86 : 0.68}
          toneMapped={false}
          transparent
        />
      </mesh>
      {/* V1-style visible face / edge / corner target grid. */}
      {face.targets.map((target, index) => {
        const cell = resolveViewCubeTargetCell(
          index,
          VIEW_CUBE_FACE_SIZE,
          VIEW_CUBE_EDGE_SIZE,
        );
        const isHovered = hoveredTargetId === `${face.id}:${target.id}`;
        const targetKind = target.kind ?? "face";
        const cellMaterial = viewCubeCellMaterial(
          targetKind,
          isHovered,
          faceHovered,
          placement.accent,
        );
        const cellInset = targetKind === "face" ? 0.9 : 0.5;
        return (
          <mesh
            key={`${face.id}:${target.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onSnap(target.direction as Direction3);
            }}
            onPointerOut={() => onHoverChange(null)}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHoverChange(`${face.id}:${target.id}`);
            }}
            position={[cell.x, cell.y, 0.24]}
            renderOrder={WIDGET_RENDER_ORDER + 3}
          >
            <planeGeometry
              args={[
                Math.max(cell.width - cellInset, 0.1),
                Math.max(cell.height - cellInset, 0.1),
              ]}
            />
            <meshBasicMaterial
              color={cellMaterial.color}
              depthTest={false}
              depthWrite={false}
              map={targetKind === "face" ? (isHovered ? hoveredTexture : normalTexture) : null}
              opacity={cellMaterial.opacity}
              toneMapped={false}
              transparent
            />
          </mesh>
        );
      })}
      {VIEW_CUBE_FACE_GRID_POINTS.map((line) => (
        <Line
          key={viewCubeSegmentKey(line)}
          color={String(colors.wire)}
          depthTest={false}
          lineWidth={1.15}
          opacity={faceHovered ? 0.58 : 0.36}
          points={line}
          renderOrder={WIDGET_RENDER_ORDER + 4}
          transparent
        />
      ))}
    </group>
  );
}

function viewCubeCellMaterial(
  kind: ViewCubeTargetKind,
  hovered: boolean,
  faceHovered: boolean,
  accent: string,
): { color: string; opacity: number } {
  if (hovered) {
    return {
      color: accent,
      opacity: kind === "face" ? 1 : kind === "edge" ? 0.9 : 0.96,
    };
  }

  if (kind === "face") {
    return {
      color: "#ffffff",
      opacity: faceHovered ? 0.98 : 0.9,
    };
  }

  if (kind === "edge") {
    return {
      color: "#26344a",
      opacity: faceHovered ? 0.76 : 0.58,
    };
  }

  return {
    color: "#30415c",
    opacity: faceHovered ? 0.84 : 0.66,
  };
}

export function HslReferenceSphere({ colors }: { colors: Viewport3DColors }) {
  const geometry = useMemo(() => buildHslSphereGeometry(), []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group scale={[40, 40, 40]}>
      {/* Soft glow halo — BackSide sphere slightly larger */}
      <mesh renderOrder={WIDGET_RENDER_ORDER - 1}>
        <sphereGeometry args={[1.09, 32, 18]} />
        <meshBasicMaterial
          color="#8ec8ff"
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

function AxisLabelSprite({
  color,
  label,
  outlineColor,
  position,
  renderOrder = WIDGET_RENDER_ORDER + 5,
  scale = [0.88, 0.42, 1],
}: {
  color: string;
  label: string;
  outlineColor: string;
  position: [number, number, number];
  renderOrder?: number;
  scale?: [number, number, number];
}) {
  const texture = useMemo(
    () => buildAxisLabelTexture(label, color, outlineColor),
    [color, label, outlineColor],
  );

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite
      position={position}
      renderOrder={renderOrder}
      scale={scale}
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

function trimPositiveAxisLabel(label: string): string {
  return label.startsWith("+") ? label.slice(1) : label;
}

function buildViewCubeEdgePoints(
  half: number,
): Array<[[number, number, number], [number, number, number]]> {
  const lows = [-half, half] as const;
  const edges: Array<[[number, number, number], [number, number, number]]> = [];

  for (const y of lows) {
    for (const z of lows) {
      edges.push([
        [-half, y, z],
        [half, y, z],
      ]);
    }
  }
  for (const x of lows) {
    for (const z of lows) {
      edges.push([
        [x, -half, z],
        [x, half, z],
      ]);
    }
  }
  for (const x of lows) {
    for (const y of lows) {
      edges.push([
        [x, y, -half],
        [x, y, half],
      ]);
    }
  }

  return edges;
}

function buildViewCubeFaceGridPoints(
  half: number,
  edgeSize: number,
): Array<[[number, number, number], [number, number, number]]> {
  const inner = half - edgeSize;
  const z = 0.42;

  return [
    [
      [-inner, -half, z],
      [-inner, half, z],
    ],
    [
      [inner, -half, z],
      [inner, half, z],
    ],
    [
      [-half, -inner, z],
      [half, -inner, z],
    ],
    [
      [-half, inner, z],
      [half, inner, z],
    ],
  ];
}

function viewCubeSegmentKey(
  line: [[number, number, number], [number, number, number]],
): string {
  return `${line[0].join(",")}:${line[1].join(",")}`;
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
    context.font = "800 38px Inter, Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 8;
    context.strokeStyle = outlineColor;
    context.fillStyle = color;
    context.strokeText(label, 64, 34);
    context.fillText(label, 64, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function buildViewCubeFaceTexture(
  label: string,
  accentColor: string,
  hovered: boolean,
): CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    const bw = hovered ? 7 : 4;
    const margin = bw / 2 + 3;
    const r = 20;
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, hovered ? "rgba(62,82,118,0.98)" : "rgba(42,56,80,0.94)");
    gradient.addColorStop(1, hovered ? "rgba(30,45,72,0.98)" : "rgba(20,31,50,0.94)");

    ctx.beginPath();
    ctx.moveTo(margin + r, margin);
    ctx.lineTo(size - margin - r, margin);
    ctx.quadraticCurveTo(size - margin, margin, size - margin, margin + r);
    ctx.lineTo(size - margin, size - margin - r);
    ctx.quadraticCurveTo(size - margin, size - margin, size - margin - r, size - margin);
    ctx.lineTo(margin + r, size - margin);
    ctx.quadraticCurveTo(margin, size - margin, margin, size - margin - r);
    ctx.lineTo(margin, margin + r);
    ctx.quadraticCurveTo(margin, margin, margin + r, margin);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = bw;
    ctx.globalAlpha = hovered ? 0.98 : 0.62;
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    const fontSize = hovered ? 48 : 42;
    ctx.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.72)";
    ctx.strokeText(label, size / 2, size / 2);
    ctx.fillStyle = hovered ? "#ffffff" : "rgba(210,225,255,0.88)";
    ctx.fillText(label, size / 2, size / 2);
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
  const near = cameraNear(camera);
  const far = cameraFar(camera);
  const distance = Math.min(far * 0.99, Math.max(WIDGET_CAMERA_DISTANCE, near * 10));
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
