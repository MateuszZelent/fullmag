"use client";

import { Line, Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, Matrix4, Vector3, type Group } from "three";

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
  resolveViewCubeTargetCell,
  type ViewCubeFaceModel,
  type ViewCubeTargetKind,
} from "./viewCubeModel";

export type OrbitControlsHandle = {
  enabled?: boolean;
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
  controls?: OrbitControlsHandle;
  onOrbit: (deltaX: number) => void;
  onOrbitEnd: () => void;
  onSnap: (direction: Direction3) => void;
}) {
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const axisLabels = getViewCubeAxisLabels();
  const faces = useMemo(() => buildViewCubeFaces(), []);
  const faceTextures = useMemo(
    () => ({
      hovered: buildViewCubeFaceTexture(colors, true),
      normal: buildViewCubeFaceTexture(colors, false),
    }),
    [colors],
  );

  useEffect(
    () => () => {
      faceTextures.normal.dispose();
      faceTextures.hovered.dispose();
    },
    [faceTextures],
  );

  return (
    <group>
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
      <group position={[0, 0, -VIEW_CUBE_HALF]}>
        <OrbitRing3D
          controls={controls}
          onOrbit={onOrbit}
          onOrbitEnd={onOrbitEnd}
        />
      </group>
      <AxisLabelSprite
        color={String(colors.textPrimary ?? "rgb(228, 228, 231)")}
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
  controls,
  onOrbit,
  onOrbitEnd,
}: {
  controls?: OrbitControlsHandle;
  onOrbit: (dx: number) => void;
  onOrbitEnd: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const gl = useThree((s) => s.gl);
  const controlsRef = useRef(controls);
  const onOrbitRef = useRef(onOrbit);
  const onOrbitEndRef = useRef(onOrbitEnd);
  const previousControlsEnabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    onOrbitRef.current = onOrbit;
  });

  useEffect(() => {
    onOrbitEndRef.current = onOrbitEnd;
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
      const wasDragging = isDragging.current;
      isDragging.current = false;
      restoreOrbitControls();
      if (wasDragging) {
        onOrbitEndRef.current();
      }
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
          color={hovered ? "rgb(251, 146, 60)" : "rgb(107, 114, 128)"}
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
            color="rgb(249, 115, 22)"
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
              map={
                targetKind === "face"
                  ? isHovered
                    ? textures.hovered
                    : textures.normal
                  : null
              }
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
      color: "white",
      opacity: hovered ? 1 : faceHovered ? 0.97 : 0.88,
    };
  }

  if (hovered) {
    return {
      color: "rgb(251, 146, 60)",
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
      fireGrad.addColorStop(0.0, "rgba(253, 186, 116, 0.55)");
      fireGrad.addColorStop(0.45, "rgba(234, 88, 12, 0.45)");
      fireGrad.addColorStop(1.0, "rgba(124, 45, 18, 0.72)");
      ctx.fillStyle = fireGrad;
      ctx.fillRect(0, 0, size, size);

      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "rgba(251, 146, 60, 0.95)";
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, size - 10, size - 10);

      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "rgba(253, 224, 167, 0.9)";
      ctx.lineWidth = 3;
      ctx.strokeRect(12, 12, size - 24, size - 24);
    } else {
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = String(colors.panelRaised ?? colors.panel ?? "rgb(82, 82, 91)");
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

