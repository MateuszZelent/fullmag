"use client";

import { Line, Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  CanvasTexture,
  Color,
  DoubleSide,
  Raycaster,
  Matrix4,
  Vector2,
  Vector3,
  type Intersection,
  type Group,
  type Object3D,
} from "three";

import type { Viewport3DColors } from "../viewport3dTypes";
import type { Direction3 } from "./cameraOrientation";
import { AxisLabelSprite } from "./AxisLabelSprite";
import {
  ORBIT_RING_RADIUS,
  ORBIT_RING_TUBE,
  VIEW_CUBE_EDGE_SIZE,
  VIEW_CUBE_FACE_SIZE,
  VIEW_CUBE_HALF,
  VIEW_CUBE_LABEL_DISTANCE,
  WIDGET_RENDER_ORDER,
} from "./orientationHudConstants";
import {
  buildViewCubeFaces,
  getViewCubeAxisLabels,
  resolveViewCubeBoxHitDirection,
  resolveViewCubeTargetCell,
  type ViewCubeFaceModel,
  type ViewCubeTargetKind,
} from "./viewCubeModel";

export type ViewportCameraControlsHandle = {
  enabled?: boolean;
  getTarget?: (out: Vector3, receiveEndValue?: boolean) => Vector3;
  setLookAt?: (
    positionX: number,
    positionY: number,
    positionZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    enableTransition?: boolean,
  ) => Promise<void>;
  target?: Vector3;
  update?: (delta?: number) => void;
};

const VIEW_CUBE_EDGE_LINES = buildViewCubeEdgeLines(VIEW_CUBE_HALF);
const VIEW_CUBE_FACE_GRID_POINTS = buildViewCubeFaceGridPoints(
  VIEW_CUBE_HALF,
  VIEW_CUBE_EDGE_SIZE,
);
const VIEW_CUBE_FACE_PLACEMENTS: Record<
  ViewCubeFaceModel["id"],
  {
    axis: "x" | "y" | "z";
    position: [number, number, number];
    rotation: [number, number, number];
  }
> = {
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

export function ViewCube3DBox({
  colors,
  controls,
  onOrbit,
  onOrbitEnd,
  onSnap,
}: {
  colors: Viewport3DColors;
  controls?: ViewportCameraControlsHandle;
  onOrbit: (deltaX: number) => void;
  onOrbitEnd: () => void;
  onSnap: (direction: Direction3) => void;
}) {
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const cubeGroupRef = useRef<Group>(null);
  const onSnapRef = useLatestRef(onSnap);
  const axisLabels = getViewCubeAxisLabels();
  const faces = useMemo(() => buildViewCubeFaces(), []);
  const faceTextures = useMemo(
    () => ({
      hovered: buildViewCubeFaceTexture(colors, true),
      normal: buildViewCubeFaceTexture(colors, false),
    }),
    [colors],
  );
  const raycastState = useMemo(
    () => ({
      pointer: new Vector2(),
      raycaster: new Raycaster(),
    }),
    [],
  );

  useEffect(
    () => () => {
      faceTextures.normal.dispose();
      faceTextures.hovered.dispose();
    },
    [faceTextures],
  );

  useEffect(() => {
    const element = gl.domElement;

    const handlePointerDown = (event: PointerEvent) => {
      const group = cubeGroupRef.current;
      if (!group) return;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;

      const { pointer, raycaster } = raycastState;
      pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
      camera.updateMatrixWorld(true);
      group.updateMatrixWorld(true);
      raycaster.setFromCamera(pointer, camera);

      const direction = resolveViewCubeNativeHitDirection(
        raycaster.intersectObject(group, true),
      );
      if (!direction) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onSnapRef.current(direction);
    };

    element.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
    });
    return () => {
      element.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
    };
  }, [camera, gl, onSnapRef, raycastState]);

  return (
    <group>
      <group ref={cubeGroupRef}>
        <mesh
          onPointerDown={(event) => {
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            event.nativeEvent.stopImmediatePropagation();
            const point = event.object.worldToLocal(event.point.clone());
            onSnap(
              resolveViewCubeBoxHitDirection(
                point.toArray() as Direction3,
                VIEW_CUBE_FACE_SIZE,
                VIEW_CUBE_EDGE_SIZE,
              ),
            );
          }}
          renderOrder={WIDGET_RENDER_ORDER}
          userData={{ viewCubeFallbackBox: true }}
        >
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
              textures={faceTextures}
            />
          );
        })}
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
      </group>
      <group position={[0, 0, -VIEW_CUBE_HALF]}>
        <OrbitRing3D
          colors={colors}
          controls={controls}
          onOrbit={onOrbit}
          onOrbitEnd={onOrbitEnd}
        />
      </group>
      <AxisLabelSprite
        color={String(colors.textPrimary ?? colors.textSecondary ?? colors.wire)}
        label={trimPositiveAxisLabel(axisLabels.x)}
        outlineColor={String(colors.background)}
        position={[VIEW_CUBE_LABEL_DISTANCE, 0, 0]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
      <AxisLabelSprite
        color={String(colors.textPrimary ?? "rgb(228, 228, 231)")}
        label={trimPositiveAxisLabel(axisLabels.y)}
        outlineColor={String(colors.background)}
        position={[0, VIEW_CUBE_LABEL_DISTANCE, 0]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
      <AxisLabelSprite
        color={String(colors.textPrimary ?? "rgb(228, 228, 231)")}
        label={trimPositiveAxisLabel(axisLabels.z)}
        outlineColor={String(colors.background)}
        position={[0, 0, VIEW_CUBE_LABEL_DISTANCE]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
        scale={[32, 20, 1]}
      />
    </group>
  );
}

function OrbitRing3D({
  colors,
  controls,
  onOrbit,
  onOrbitEnd,
}: {
  colors: Viewport3DColors;
  controls?: ViewportCameraControlsHandle;
  onOrbit: (dx: number) => void;
  onOrbitEnd: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const controlsRef = useRef(controls);
  const onOrbitRef = useLatestRef(onOrbit);
  const onOrbitEndRef = useLatestRef(onOrbitEnd);
  const previousControlsEnabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
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
      const wasDragging = isDragging.current;
      isDragging.current = false;
      restoreOrbitControls();
      if (wasDragging) {
        onOrbitEndRef.current();
      }
    };
    window.addEventListener("pointermove", handleMove, { capture: true });
    window.addEventListener("pointerup", handleUp, { capture: true });
    window.addEventListener("pointercancel", handleUp, { capture: true });
    return () => {
      window.removeEventListener("pointermove", handleMove, { capture: true });
      window.removeEventListener("pointerup", handleUp, { capture: true });
      window.removeEventListener("pointercancel", handleUp, { capture: true });
      restoreOrbitControls();
    };
  }, [onOrbitEndRef, onOrbitRef]);

  return (
    <group renderOrder={WIDGET_RENDER_ORDER + 1}>
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
          color={hovered ? String(colors.accent) : String(colors.wire)}
          depthTest={false}
          depthWrite={false}
          opacity={hovered ? 0.92 : 0.42}
          toneMapped={false}
          transparent
        />
      </mesh>
      {hovered ? (
        <mesh renderOrder={WIDGET_RENDER_ORDER}>
          <torusGeometry
            args={[ORBIT_RING_RADIUS, ORBIT_RING_TUBE + 2.5, 20, 80]}
          />
          <meshBasicMaterial
            color={String(colors.accentStrong ?? colors.accent)}
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

function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function resolveViewCubeNativeHitDirection(
  intersections: Array<Intersection<Object3D>>,
): Direction3 | null {
  for (const intersection of intersections) {
    const explicitDirection = viewCubeTargetDirectionFromObject(
      intersection.object,
    );
    if (explicitDirection) return explicitDirection;

    if (viewCubeObjectUserData(intersection.object).viewCubeFallbackBox) {
      const point = intersection.object.worldToLocal(intersection.point.clone());
      return resolveViewCubeBoxHitDirection(
        point.toArray() as Direction3,
        VIEW_CUBE_FACE_SIZE,
        VIEW_CUBE_EDGE_SIZE,
      );
    }
  }

  return null;
}

function viewCubeTargetDirectionFromObject(object: Object3D): Direction3 | null {
  let current: Object3D | null = object;
  while (current) {
    const direction = viewCubeObjectUserData(current).viewCubeTargetDirection;
    if (isDirection3(direction)) return direction;
    current = current.parent;
  }
  return null;
}

function viewCubeObjectUserData(object: Object3D): {
  viewCubeFallbackBox?: unknown;
  viewCubeTargetDirection?: unknown;
} {
  return object.userData as {
    viewCubeFallbackBox?: unknown;
    viewCubeTargetDirection?: unknown;
  };
}

function isDirection3(value: unknown): value is Direction3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number")
  );
}

function ViewCubeFacePanel({
  colors,
  face,
  faceHovered,
  hoveredTargetId,
  onHoverChange,
  onSnap,
  textures,
}: {
  colors: Viewport3DColors;
  face: ViewCubeFaceModel;
  faceHovered: boolean;
  hoveredTargetId: string | null;
  onHoverChange: (id: string | null) => void;
  onSnap: (direction: Direction3) => void;
  textures: { hovered: CanvasTexture; normal: CanvasTexture };
}) {
  const placement = VIEW_CUBE_FACE_PLACEMENTS[face.id];
  const label = VIEW_CUBE_FACE_LABELS[face.id];

  return (
    <group position={placement.position} rotation={placement.rotation}>
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
          colors,
        );
        const cellInset = targetKind === "face" ? 0.9 : 0.5;
        return (
          <mesh
            key={`${face.id}:${target.id}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.nativeEvent.preventDefault();
              event.nativeEvent.stopImmediatePropagation();
              onSnap(target.direction as Direction3);
            }}
            onPointerOut={() => onHoverChange(null)}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHoverChange(`${face.id}:${target.id}`);
            }}
            position={[cell.x, cell.y, 0.24]}
            renderOrder={WIDGET_RENDER_ORDER + 3}
            userData={{ viewCubeTargetDirection: target.direction }}
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
              map={
                targetKind === "face"
                  ? isHovered
                    ? textures.hovered
                    : textures.normal
                  : null
              }
              opacity={cellMaterial.opacity}
              side={DoubleSide}
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

function AutoOrientText({ color, label }: { color: string; label: string }) {
  const ref = useRef<Group>(null);
  const scratch = useMemo(
    () => ({
      cameraUp: new Vector3(),
      parentInverse: new Matrix4(),
    }),
    [],
  );

  useFrame(({ camera }) => {
    if (!ref.current || !ref.current.parent) return;

    scratch.cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    scratch.parentInverse.copy(ref.current.parent.matrixWorld).invert();
    scratch.cameraUp.transformDirection(scratch.parentInverse);

    const angle = Math.atan2(scratch.cameraUp.y, scratch.cameraUp.x);
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
  colors: Viewport3DColors,
): { color: string; opacity: number } {
  if (kind === "face") {
    return {
      color: String(colors.textPrimary ?? "white"),
      opacity: hovered ? 1 : faceHovered ? 0.97 : 0.88,
    };
  }

  if (hovered) {
    return {
      color: String(colors.accent),
      opacity: kind === "edge" ? 0.85 : 0.95,
    };
  }

  return {
    color: String(colors.panelRaised ?? colors.panel ?? colors.mesh),
    opacity: faceHovered ? 0.35 : 0.08,
  };
}

function buildViewCubeFaceTexture(
  colors: Viewport3DColors,
  hovered: boolean,
): CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const accentRgb = colorToRgba(colors.accent);
    const accentStrongRgb = colorToRgba(colors.accentStrong ?? colors.accent);
    ctx.clearRect(0, 0, size, size);

    if (hovered) {
      ctx.globalAlpha = 1.0;
      const fireGrad = ctx.createRadialGradient(
        size * 0.5,
        size * 0.5,
        0,
        size * 0.5,
        size * 0.5,
        size * 0.72,
      );
      // Lighter accent at center → accent strong mid → darkened accent at edges
      fireGrad.addColorStop(0.0, rgbaString(accentRgb.r, accentRgb.g, accentRgb.b, 0.55, 1.25));
      fireGrad.addColorStop(0.45, rgbaString(accentStrongRgb.r, accentStrongRgb.g, accentStrongRgb.b, 0.45));
      fireGrad.addColorStop(1.0, rgbaString(accentStrongRgb.r, accentStrongRgb.g, accentStrongRgb.b, 0.72, 0.5));
      ctx.fillStyle = fireGrad;
      ctx.fillRect(0, 0, size, size);

      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = rgbaString(accentRgb.r, accentRgb.g, accentRgb.b, 0.95);
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, size - 10, size - 10);

      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = rgbaString(accentRgb.r, accentRgb.g, accentRgb.b, 0.9, 1.5);
      ctx.lineWidth = 3;
      ctx.strokeRect(12, 12, size - 24, size - 24);
    } else {
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = String(colors.panelRaised ?? colors.panel ?? colors.wire);
      ctx.fillRect(0, 0, size, size);

      const vignette = ctx.createRadialGradient(
        size * 0.5,
        size * 0.5,
        size * 0.2,
        size * 0.5,
        size * 0.5,
        size * 0.84,
      );
      vignette.addColorStop(0.0, "rgba(0, 0, 0, 0.0)");
      vignette.addColorStop(0.7, "rgba(0, 0, 0, 0.16)");
      vignette.addColorStop(1.0, "rgba(0, 0, 0, 0.38)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, size, size);

      ctx.globalAlpha = 0.38;
      ctx.strokeStyle = String(colors.wire);
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, size - 4, size - 4);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.anisotropy = 4;
  return texture;
}

function buildViewCubeEdgeLines(
  half: number,
): Array<{
  points: [[number, number, number], [number, number, number]];
  axis: "x" | "y" | "z";
}> {
  const lows = [-half, half] as const;
  const edges: Array<{
    points: [[number, number, number], [number, number, number]];
    axis: "x" | "y" | "z";
  }> = [];

  for (const y of lows) {
    for (const z of lows) {
      edges.push({
        axis: "x",
        points: [
          [-half, y, z],
          [half, y, z],
        ],
      });
    }
  }
  for (const x of lows) {
    for (const z of lows) {
      edges.push({
        axis: "y",
        points: [
          [x, -half, z],
          [x, half, z],
        ],
      });
    }
  }
  for (const x of lows) {
    for (const y of lows) {
      edges.push({
        axis: "z",
        points: [
          [x, y, -half],
          [x, y, half],
        ],
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

function trimPositiveAxisLabel(label: string): string {
  return label.startsWith("+") ? label.slice(1) : label;
}

/** Convert any Three.js ColorRepresentation to { r, g, b } in 0-255 range. */
function colorToRgba(c: import("three").ColorRepresentation): { r: number; g: number; b: number } {
  const col = new Color(c);
  return { r: Math.round(col.r * 255), g: Math.round(col.g * 255), b: Math.round(col.b * 255) };
}

/**
 * Build an `rgba(…)` CSS string from 0-255 channel values.
 * Optional `brightness` multiplier (1 = identity) shifts channels for
 * lighter / darker variants without a separate color token.
 */
function rgbaString(
  r: number, g: number, b: number,
  a: number,
  brightness = 1,
): string {
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return `rgba(${clamp(r * brightness)}, ${clamp(g * brightness)}, ${clamp(b * brightness)}, ${a})`;
}
