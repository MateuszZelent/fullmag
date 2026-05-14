"use client";

import { Line, Text } from "@react-three/drei";
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
import { applyViewport3DWorldUp } from "../layers/CameraControls";

import {
  orbitCameraAroundTarget,
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
  enabled?: boolean;
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
const VIEW_CUBE_EDGE_LINES = buildViewCubeEdgeLines(VIEW_CUBE_HALF);
const VIEW_CUBE_FACE_GRID_POINTS = buildViewCubeFaceGridPoints(
  VIEW_CUBE_HALF,
  VIEW_CUBE_EDGE_SIZE,
);
// ── Orbit ring constants (depend on VIEW_CUBE_HALF) ──────────────────────────
const ORBIT_RING_RADIUS = VIEW_CUBE_HALF * 1.52;
const ORBIT_RING_TUBE = 3.2;
const ORBIT_SENSITIVITY = 0.0045;
const VIEW_CUBE_FACE_PLACEMENTS: Record<ViewCubeFaceModel["id"], {
  axis: "x" | "y" | "z";
  position: [number, number, number];
  rotation: [number, number, number];
}> = {
  right: {
    axis: "x",
    position: [VIEW_CUBE_HALF, 0, 0],
    rotation: [0, Math.PI / 2, 0],
  },
  left: {
    axis: "x",
    position: [-VIEW_CUBE_HALF, 0, 0],
    rotation: [0, -Math.PI / 2, 0],
  },
  top: {
    axis: "z",
    position: [0, 0, VIEW_CUBE_HALF],
    rotation: [0, 0, 0],
  },
  bottom: {
    axis: "z",
    position: [0, 0, -VIEW_CUBE_HALF],
    rotation: [0, Math.PI, 0],
  },
  front: {
    axis: "y",
    position: [0, VIEW_CUBE_HALF, 0],
    rotation: [-Math.PI / 2, 0, 0],
  },
  back: {
    axis: "y",
    position: [0, -VIEW_CUBE_HALF, 0],
    rotation: [Math.PI / 2, 0, 0],
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

// Monochrome: all axes share the same neutral wire color (theme-aware)
function viewCubeAxisColors(
  colors: Viewport3DColors,
): Record<"x" | "y" | "z", string> {
  const c = String(colors.wire);
  return { x: c, y: c, z: c };
}

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

      applyViewport3DWorldUp(camera);
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

  const onOrbit = useCallback(
    (deltaX: number) => {
      const target = getTarget();
      const nextCamera = orbitCameraAroundTarget(
        {
          position: camera.position.toArray() as [number, number, number],
          target: target.toArray() as [number, number, number],
        },
        deltaX,
        ORBIT_SENSITIVITY,
      );

      applyViewport3DWorldUp(camera);
      camera.position.set(nextCamera.position[0], nextCamera.position[1], nextCamera.position[2]);
      camera.lookAt(nextCamera.target[0], nextCamera.target[1], nextCamera.target[2]);
      camera.updateProjectionMatrix();
      controls?.target?.set(nextCamera.target[0], nextCamera.target[1], nextCamera.target[2]);
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
          <ViewCube3DBox
            colors={colors}
            controls={controls}
            onOrbit={onOrbit}
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
  controls,
  onOrbit,
  onSnap,
}: {
  colors: Viewport3DColors;
  controls?: OrbitControlsHandle;
  onOrbit: (deltaX: number) => void;
  onSnap: (direction: Direction3) => void;
}) {
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const axisLabels = getViewCubeAxisLabels();
  const faces = useMemo(() => buildViewCubeFaces(), []);

  return (
    <group>
      {/* Monolithic cube body — uses theme-aware panel color */}
      <mesh renderOrder={WIDGET_RENDER_ORDER}>
        <boxGeometry
          args={[
            VIEW_CUBE_FACE_SIZE - 0.2,
            VIEW_CUBE_FACE_SIZE - 0.2,
            VIEW_CUBE_FACE_SIZE - 0.2,
          ]}
        />
        <meshBasicMaterial
          color={String(colors.panelRaised ?? colors.panel ?? colors.mesh)}
          depthTest={false}
          depthWrite={false}
          opacity={0.97}
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
      {/* Uniform monochrome cube edges — theme-aware wire color */}
      {VIEW_CUBE_EDGE_LINES.map((edge) => (
        <Line
          key={viewCubeSegmentKey(edge.points)}
          color={String(colors.wire)}
          depthTest={false}
          lineWidth={1.8}
          opacity={0.55}
          points={edge.points}
          renderOrder={WIDGET_RENDER_ORDER + 2}
          transparent
        />
      ))}
      {/* 3D orbit ring at the base of the box */}
      <group position={[0, 0, -VIEW_CUBE_HALF]}>
        <OrbitRing3D controls={controls} onOrbit={onOrbit} />
      </group>
      <AxisLabelSprite
        color={String(colors.textPrimary ?? "#e4e4e7")}
        label={trimPositiveAxisLabel(axisLabels.x)}
        outlineColor={String(colors.background)}
        position={[VIEW_CUBE_LABEL_DISTANCE, 0, 0]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
      <AxisLabelSprite
        color={String(colors.textPrimary ?? "#e4e4e7")}
        label={trimPositiveAxisLabel(axisLabels.y)}
        outlineColor={String(colors.background)}
        position={[0, VIEW_CUBE_LABEL_DISTANCE, 0]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
      <AxisLabelSprite
        color={String(colors.textPrimary ?? "#e4e4e7")}
        label={trimPositiveAxisLabel(axisLabels.z)}
        outlineColor={String(colors.background)}
        position={[0, 0, VIEW_CUBE_LABEL_DISTANCE]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
    </group>
  );
}

// ── Orbit ring ─────────────────────────────────────────────────────────────────

function OrbitRing3D({
  controls,
  onOrbit,
}: {
  controls?: OrbitControlsHandle;
  onOrbit: (dx: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const gl = useThree((s) => s.gl);
  const controlsRef = useRef(controls);
  const onOrbitRef = useRef(onOrbit);
  const previousControlsEnabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    onOrbitRef.current = onOrbit;
  });

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    const canvas = gl.domElement;
    const restoreOrbitControls = () => {
      const orbitControls = controlsRef.current;
      if (
        orbitControls &&
        previousControlsEnabledRef.current !== null &&
        typeof orbitControls.enabled === "boolean"
      ) {
        orbitControls.enabled = previousControlsEnabledRef.current;
      }
      previousControlsEnabledRef.current = null;
    };
    const handleMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - lastPointer.current.x;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      onOrbitRef.current(dx);
    };
    const handleUp = () => {
      isDragging.current = false;
      restoreOrbitControls();
    };
    canvas.addEventListener("pointermove", handleMove);
    canvas.addEventListener("pointerup", handleUp);
    canvas.addEventListener("pointercancel", handleUp);
    window.addEventListener("pointerup", handleUp);
    return () => {
      canvas.removeEventListener("pointermove", handleMove);
      canvas.removeEventListener("pointerup", handleUp);
      canvas.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("pointerup", handleUp);
      restoreOrbitControls();
    };
  }, [gl]);

  return (
    <group renderOrder={WIDGET_RENDER_ORDER + 1}>
      {/* Main torus */}
      <mesh
        renderOrder={WIDGET_RENDER_ORDER + 1}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.nativeEvent.preventDefault();
          e.nativeEvent.stopImmediatePropagation();
          if (
            controlsRef.current &&
            previousControlsEnabledRef.current === null &&
            typeof controlsRef.current.enabled === "boolean"
          ) {
            previousControlsEnabledRef.current = controlsRef.current.enabled;
            controlsRef.current.enabled = false;
          }
          isDragging.current = true;
          lastPointer.current = {
            x: e.nativeEvent.clientX,
            y: e.nativeEvent.clientY,
          };
        }}
      >
        <torusGeometry args={[ORBIT_RING_RADIUS, ORBIT_RING_TUBE, 20, 80]} />
        <meshBasicMaterial
          color={hovered ? "#fb923c" : "#6b7280"}
          depthTest={false}
          depthWrite={false}
          opacity={hovered ? 0.92 : 0.42}
          toneMapped={false}
          transparent
        />
      </mesh>
      {/* Soft glow halo on hover */}
      {hovered ? (
        <mesh renderOrder={WIDGET_RENDER_ORDER}>
          <torusGeometry args={[ORBIT_RING_RADIUS, ORBIT_RING_TUBE + 2.5, 20, 80]} />
          <meshBasicMaterial
            color="#f97316"
            depthTest={false}
            depthWrite={false}
            opacity={0.22}
            toneMapped={false}
            transparent
          />
        </mesh>
      ) : null}
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
  const accent = viewCubeAxisColors(colors)[placement.axis];

  const normalTexture = useMemo(
    () => buildViewCubeFaceTexture(label, accent, colors, false),
    [accent, colors, label],
  );
  const hoveredTexture = useMemo(
    () => buildViewCubeFaceTexture(label, accent, colors, true),
    [accent, colors, label],
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
      {/* Recessed volumetric panel removed in favor of crisp borders */}
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
          accent,
          colors,
        );
        const cellInset = targetKind === "face" ? 0.9 : 0.5;
        return (
          <mesh
            key={`${face.id}:${target.id}`}
            onPointerDown={(event) => {
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
          lineWidth={1.0}
          opacity={faceHovered ? 0.3 : 0.15}
          points={line}
          renderOrder={WIDGET_RENDER_ORDER + 4}
          transparent
        />
      ))}
      <AutoOrientText
        color={String(colors.textPrimary ?? colors.wire)}
        label={label}
      />
    </group>
  );
}

function AutoOrientText({
  color,
  label,
}: {
  color: string;
  label: string;
}) {
  const ref = useRef<Group>(null);

  useFrame(({ camera }) => {
    if (!ref.current || !ref.current.parent) return;

    const cameraUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const m = ref.current.parent.matrixWorld.clone().invert();
    cameraUp.transformDirection(m);

    const angle = Math.atan2(cameraUp.y, cameraUp.x);
    const rot = angle - Math.PI / 2;
    const snapped = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
    ref.current.rotation.z = snapped;
  });

  return (
    <group position={[0, 0, 0.28]} ref={ref}>
      <Text
        anchorX="center"
        anchorY="middle"
        color={color}
        material-depthTest={false}
        fontSize={13}
        fontWeight={700}
        renderOrder={WIDGET_RENDER_ORDER + 5}
      >
        {label}
      </Text>
    </group>
  );
}

function viewCubeCellMaterial(
  kind: ViewCubeTargetKind,
  hovered: boolean,
  faceHovered: boolean,
  _accent: string,
  colors: Viewport3DColors,
): { color: string; opacity: number } {
  if (kind === "face") {
    // Face appearance driven entirely by texture
    return {
      color: "#ffffff",
      opacity: hovered ? 1 : (faceHovered ? 0.97 : 0.88),
    };
  }

  if (hovered) {
    // Fire amber on hover
    return {
      color: "#fb923c",
      opacity: kind === "edge" ? 0.85 : 0.95,
    };
  }

  return {
    color: String(colors.panelRaised ?? colors.panel ?? colors.mesh),
    opacity: faceHovered ? 0.35 : 0.08,
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

function buildViewCubeEdgeLines(
  half: number,
): Array<{ points: [[number, number, number], [number, number, number]]; axis: "x" | "y" | "z" }> {
  const lows = [-half, half] as const;
  const edges: Array<{ points: [[number, number, number], [number, number, number]]; axis: "x" | "y" | "z" }> = [];

  for (const y of lows) {
    for (const z of lows) {
      edges.push({
        axis: "x",
        points: [[-half, y, z], [half, y, z]],
      });
    }
  }
  for (const x of lows) {
    for (const z of lows) {
      edges.push({
        axis: "y",
        points: [[x, -half, z], [x, half, z]],
      });
    }
  }
  for (const x of lows) {
    for (const y of lows) {
      edges.push({
        axis: "z",
        points: [[x, y, -half], [x, y, half]],
      });
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
  _accentColor: string,
  _colors: Viewport3DColors,
  hovered: boolean,
): CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, size, size);

    if (hovered) {
      // ── Fiery hover: warm radial gradient from center out ──────────────
      ctx.globalAlpha = 1.0;
      const fireGrad = ctx.createRadialGradient(
        size * 0.5, size * 0.5, 0,
        size * 0.5, size * 0.5, size * 0.72,
      );
      fireGrad.addColorStop(0.0, "rgba(253, 186, 116, 0.55)");   // orange-300
      fireGrad.addColorStop(0.45, "rgba(234, 88, 12, 0.45)");    // orange-600
      fireGrad.addColorStop(1.0, "rgba(124, 45, 18, 0.72)");     // orange-950
      ctx.fillStyle = fireGrad;
      ctx.fillRect(0, 0, size, size);

      // Ember border
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "rgba(251, 146, 60, 0.95)";
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, size - 10, size - 10);

      // Inner bright edge accent
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "rgba(253, 224, 167, 0.9)";
      ctx.lineWidth = 3;
      ctx.strokeRect(12, 12, size - 24, size - 24);
    } else {
      // ── Normal state: theme-aware panel fill + corner vignette ──────────────
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = String(_colors.panelRaised ?? _colors.panel ?? "#52525b");
      ctx.fillRect(0, 0, size, size);

      // Corner darkening vignette (darker at corners = "darker corners")
      const vignette = ctx.createRadialGradient(
        size * 0.5, size * 0.5, size * 0.2,
        size * 0.5, size * 0.5, size * 0.84,
      );
      vignette.addColorStop(0.0, "rgba(0, 0, 0, 0.0)");
      vignette.addColorStop(0.7, "rgba(0, 0, 0, 0.16)");
      vignette.addColorStop(1.0, "rgba(0, 0, 0, 0.38)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, size, size);

      // Subtle border using wire color
      ctx.globalAlpha = 0.38;
      ctx.strokeStyle = String(_colors.wire);
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, size - 4, size - 4);
    }
  }

  void label; // label text is rendered separately via AutoOrientText

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.anisotropy = 4;
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
