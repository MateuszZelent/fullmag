"use client";

import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
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
  type MeshBasicMaterial,
  type Object3D,
  type Sprite,
} from "three";

import type { Viewport3DColors, Viewport3DHudColors } from "../viewport3dTypes";
import type { Direction3 } from "./cameraOrientation";
import { hudAxisColor, resolveHudColors, type HudAxisId } from "./hudColors";
import { HudTextSprite, useHudTextTexture } from "./hudText";
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
const VIEW_CUBE_FACE_LABEL_PX = 17;
const ORBIT_RING_CHEVRON_ANGLES = [Math.PI * 0.25, Math.PI * 1.25];
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

// Faces are named by the axis they look along: physics users think in +x/-y,
// and the default view otherwise greets them with "BACK".
const VIEW_CUBE_FACE_LABELS: Record<ViewCubeFaceModel["id"], string> = {
  right: "+X",
  left: "−X",
  top: "+Z",
  bottom: "−Z",
  front: "+Y",
  back: "−Y",
};

/**
 * Fixed per-face shading towards the theme shade colour: the cube turns with
 * the camera, so a world-fixed light keeps "top" brightest like CAD widgets.
 */
const VIEW_CUBE_FACE_SHADE: Record<ViewCubeFaceModel["id"], number> = {
  top: 0,
  right: 0.08,
  left: 0.08,
  front: 0.15,
  back: 0.15,
  bottom: 0.24,
};

const VIEW_CUBE_AXES: Array<{ axis: HudAxisId; direction: [number, number, number] }> = [
  { axis: "x", direction: [1, 0, 0] },
  { axis: "y", direction: [0, 1, 0] },
  { axis: "z", direction: [0, 0, 1] },
];

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
  const faces = useMemo(() => buildViewCubeFaces(), []);
  const hud = useMemo(() => resolveHudColors(colors), [colors]);
  const faceColors = useMemo(() => buildViewCubeFaceColors(hud), [hud]);
  const raycastState = useMemo(
    () => ({
      pointer: new Vector2(),
      raycaster: new Raycaster(),
    }),
    [],
  );

  useEffect(() => {
    const element = gl.domElement;
    let cachedRect = element.getBoundingClientRect();
    const resizeObserver = new ResizeObserver(() => {
      cachedRect = element.getBoundingClientRect();
    });

    const handlePointerDown = (event: PointerEvent) => {
      const group = cubeGroupRef.current;
      if (!group) return;

      const rect = cachedRect;
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

    resizeObserver.observe(element);
    element.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
    });
    return () => {
      element.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      resizeObserver.disconnect();
    };
  }, [camera, gl, onSnapRef, raycastState]);

  return (
    <group>
      <group ref={cubeGroupRef}>
        <mesh
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
            color={hud.cubeFace}
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
              accent={String(colors.accent)}
              face={face}
              faceColor={faceColors[face.id]}
              faceHovered={faceHovered}
              hud={hud}
              hoveredTargetId={hoveredTargetId}
              onHoverChange={setHoveredTargetId}
              onSnap={onSnap}
            />
          );
        })}
        {VIEW_CUBE_EDGE_LINES.map((edge) => (
          <Line
            key={viewCubeSegmentKey(edge.points)}
            color={hud.cubeEdge}
            depthTest={false}
            lineWidth={1.3}
            opacity={0.95}
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
      {VIEW_CUBE_AXES.map(({ axis, direction }) => (
        <ViewCubeAxisMarker
          key={axis}
          color={hudAxisColor(hud, axis)}
          direction={direction}
          halo={hud.halo}
          label={axis.toUpperCase()}
        />
      ))}
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
  const dragListenersAttachedRef = useRef(false);
  const dragMoveListenerRef = useRef<((event: PointerEvent) => void) | null>(
    null,
  );
  const dragEndListenerRef = useRef<((event: PointerEvent) => void) | null>(
    null,
  );

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  const restoreOrbitControls = useCallback(() => {
    const orbitControls = controlsRef.current;
    if (
      orbitControls &&
      previousControlsEnabledRef.current !== null &&
      typeof orbitControls.enabled === "boolean"
    ) {
      orbitControls.enabled = previousControlsEnabledRef.current;
    }
    previousControlsEnabledRef.current = null;
  }, []);

  const handleMove = useCallback(
    (e: PointerEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - lastPointer.current.x;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      onOrbitRef.current(dx);
    },
    [onOrbitRef],
  );

  const detachWindowDragListeners = useCallback(() => {
    if (!dragListenersAttachedRef.current) return;
    dragListenersAttachedRef.current = false;
    dragMoveListenerRef.current = null;
    dragEndListenerRef.current = null;
  }, []);

  const handleUp = useCallback(() => {
    const wasDragging = isDragging.current;
    isDragging.current = false;
    detachWindowDragListeners();
    restoreOrbitControls();
    if (wasDragging) {
      onOrbitEndRef.current();
    }
  }, [detachWindowDragListeners, onOrbitEndRef, restoreOrbitControls]);

  const attachWindowDragListeners = useCallback(() => {
    if (dragListenersAttachedRef.current) return;
    dragListenersAttachedRef.current = true;
    const dragMoveListener = (event: PointerEvent) => handleMove(event);
    const dragEndListener = () => handleUp();
    dragMoveListenerRef.current = dragMoveListener;
    dragEndListenerRef.current = dragEndListener;
  }, [handleMove, handleUp]);

  useEffect(() => {
    const listenerController = new AbortController();
    const dragMoveListener = (event: PointerEvent) => handleMove(event);
    const dragEndListener = () => handleUp();
    window.addEventListener("pointermove", dragMoveListener, {
      capture: true,
      signal: listenerController.signal,
    });
    window.addEventListener("pointerup", dragEndListener, {
      capture: true,
      signal: listenerController.signal,
    });
    window.addEventListener("pointercancel", dragEndListener, {
      capture: true,
      signal: listenerController.signal,
    });
    return () => {
      listenerController.abort();
      detachWindowDragListeners();
      restoreOrbitControls();
    };
  }, [detachWindowDragListeners, handleMove, handleUp, restoreOrbitControls]);

  const ringColor = hovered
    ? String(colors.accent)
    : resolveHudColors(colors).cubeEdge;

  return (
    <group renderOrder={WIDGET_RENDER_ORDER + 1}>
      {/* Wide, invisible hit target; the visible ring is drawn thinner below. */}
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
          attachWindowDragListeners();
        }}
      >
        <torusGeometry args={[ORBIT_RING_RADIUS, ORBIT_RING_TUBE, 12, 80]} />
        <meshBasicMaterial
          depthTest={false}
          depthWrite={false}
          opacity={0}
          toneMapped={false}
          transparent
        />
      </mesh>
      <mesh renderOrder={WIDGET_RENDER_ORDER + 1}>
        <torusGeometry
          args={[ORBIT_RING_RADIUS, hovered ? 1.9 : 1.3, 12, 96]}
        />
        <meshBasicMaterial
          color={ringColor}
          depthTest={false}
          depthWrite={false}
          opacity={hovered ? 0.95 : 0.6}
          toneMapped={false}
          transparent
        />
      </mesh>
      {ORBIT_RING_CHEVRON_ANGLES.map((angle) => (
        <mesh
          key={angle}
          position={[
            Math.cos(angle) * ORBIT_RING_RADIUS,
            Math.sin(angle) * ORBIT_RING_RADIUS,
            0,
          ]}
          renderOrder={WIDGET_RENDER_ORDER + 2}
          rotation={[0, 0, angle]}
        >
          <coneGeometry args={[3.4, 7, 3]} />
          <meshBasicMaterial
            color={ringColor}
            depthTest={false}
            depthWrite={false}
            opacity={hovered ? 1 : 0.75}
            toneMapped={false}
            transparent
          />
        </mesh>
      ))}
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
  accent,
  face,
  faceColor,
  faceHovered,
  hoveredTargetId,
  hud,
  onHoverChange,
  onSnap,
}: {
  accent: string;
  face: ViewCubeFaceModel;
  faceColor: string;
  faceHovered: boolean;
  hoveredTargetId: string | null;
  hud: Viewport3DHudColors;
  onHoverChange: (id: string | null) => void;
  onSnap: (direction: Direction3) => void;
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
          faceColor,
          accent,
        );
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
            <planeGeometry args={[Math.max(cell.width, 0.1), Math.max(cell.height, 0.1)]} />
            <meshBasicMaterial
              color={cellMaterial.color}
              depthTest={false}
              depthWrite={false}
              opacity={cellMaterial.opacity}
              side={DoubleSide}
              toneMapped={false}
              transparent
            />
          </mesh>
        );
      })}
      {faceHovered
        ? VIEW_CUBE_FACE_GRID_POINTS.map((line) => (
            <Line
              key={viewCubeSegmentKey(line)}
              color={accent}
              depthTest={false}
              lineWidth={1.0}
              opacity={0.45}
              points={line}
              renderOrder={WIDGET_RENDER_ORDER + 4}
              transparent
            />
          ))
        : null}
      <AutoOrientText color={hud.label} halo={faceColor} label={label} />
    </group>
  );
}

/**
 * Face label that stays upright (snapped to 90 deg) and fades out as the face
 * turns edge-on, where a squashed label only adds noise.
 */
function AutoOrientText({
  color,
  halo,
  label,
}: {
  color: string;
  halo: string;
  label: string;
}) {
  const ref = useRef<Group>(null);
  const materialRef = useRef<MeshBasicMaterial>(null);
  const scratch = useMemo(
    () => ({
      cameraForward: new Vector3(),
      cameraUp: new Vector3(),
      faceNormal: new Vector3(),
      parentInverse: new Matrix4(),
    }),
    [],
  );
  const { heightPx, texture, widthPx } = useHudTextTexture(
    [{ color, text: label, weight: 800 }],
    { font: "ui", fontPx: VIEW_CUBE_FACE_LABEL_PX, halo, haloPx: 2 },
  );
  const labelTexture: CanvasTexture = texture;

  useFrame(({ camera }) => {
    if (!ref.current || !ref.current.parent) return;

    scratch.cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    scratch.parentInverse.copy(ref.current.parent.matrixWorld).invert();
    scratch.cameraUp.transformDirection(scratch.parentInverse);

    const angle = Math.atan2(scratch.cameraUp.y, scratch.cameraUp.x);
    const rot = angle - Math.PI / 2;
    const snapped = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
    ref.current.rotation.z = snapped;

    if (materialRef.current) {
      scratch.faceNormal
        .set(0, 0, 1)
        .transformDirection(ref.current.parent.matrixWorld);
      scratch.cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const facing = -scratch.faceNormal.dot(scratch.cameraForward);
      materialRef.current.opacity = Math.min(1, Math.max(0, (facing - 0.28) / 0.3));
    }
  });

  return (
    <group position={[0, 0, 0.28]} ref={ref}>
      <mesh renderOrder={WIDGET_RENDER_ORDER + 5}>
        <planeGeometry args={[widthPx, heightPx]} />
        <meshBasicMaterial
          ref={materialRef}
          depthTest={false}
          depthWrite={false}
          map={labelTexture}
          toneMapped={false}
          transparent
        />
      </mesh>
    </group>
  );
}

/** Axis identity outside the cube: a coloured stub from the + face and its letter. */
function ViewCubeAxisMarker({
  color,
  direction,
  halo,
  label,
}: {
  color: string;
  direction: [number, number, number];
  halo: string;
  label: string;
}) {
  const groupRef = useRef<Group>(null);
  const stubRef = useRef<Object3D>(null);
  const labelRef = useRef<Sprite>(null);
  const scratch = useMemo(
    () => ({ axis: new Vector3(), forward: new Vector3() }),
    [],
  );
  const stubStart = scaleTuple(direction, VIEW_CUBE_HALF + 1);
  const stubEnd = scaleTuple(direction, VIEW_CUBE_LABEL_DISTANCE - 9);

  // An axis pointing away from the viewer would draw its stub across the
  // cube (the HUD ignores depth), so hide the stub and dim the letter.
  useFrame(({ camera }) => {
    const group = groupRef.current;
    if (!group) return;
    scratch.axis.set(...direction).transformDirection(group.matrixWorld);
    scratch.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const away = scratch.axis.dot(scratch.forward) > 0.05;
    if (stubRef.current) stubRef.current.visible = !away;
    const material = labelRef.current?.material as { opacity: number } | undefined;
    if (material) material.opacity = away ? 0.45 : 1;
  });

  return (
    <group ref={groupRef}>
      <Line
        ref={stubRef as never}
        color={color}
        depthTest={false}
        lineWidth={2.4}
        points={[stubStart, stubEnd]}
        renderOrder={WIDGET_RENDER_ORDER + 4}
      />
      <HudTextSprite
        ref={labelRef}
        position={scaleTuple(direction, VIEW_CUBE_LABEL_DISTANCE)}
        renderOrder={WIDGET_RENDER_ORDER + 6}
        runs={[{ color, text: label, weight: 800 }]}
        style={{ font: "ui", fontPx: 13, halo }}
      />
    </group>
  );
}

function viewCubeCellMaterial(
  kind: ViewCubeTargetKind,
  hovered: boolean,
  faceHovered: boolean,
  faceColor: string,
  accent: string,
): { color: string; opacity: number } {
  if (hovered) {
    return { color: accent, opacity: kind === "face" ? 0.4 : 0.85 };
  }
  return { color: faceColor, opacity: faceHovered ? 1 : 0.98 };
}

function buildViewCubeFaceColors(
  hud: Viewport3DHudColors,
): Record<ViewCubeFaceModel["id"], string> {
  const base = new Color(hud.cubeFace);
  const shade = new Color(hud.cubeShade);
  const colorFor = (amount: number) =>
    `#${base.clone().lerp(shade, amount).getHexString()}`;
  return {
    back: colorFor(VIEW_CUBE_FACE_SHADE.back),
    bottom: colorFor(VIEW_CUBE_FACE_SHADE.bottom),
    front: colorFor(VIEW_CUBE_FACE_SHADE.front),
    left: colorFor(VIEW_CUBE_FACE_SHADE.left),
    right: colorFor(VIEW_CUBE_FACE_SHADE.right),
    top: colorFor(VIEW_CUBE_FACE_SHADE.top),
  };
}

function scaleTuple(
  direction: [number, number, number],
  scale: number,
): [number, number, number] {
  return [direction[0] * scale, direction[1] * scale, direction[2] * scale];
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
