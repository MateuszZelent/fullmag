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
  SRGBColorSpace,
  Matrix4,
  Vector2,
  Vector3,
  type Camera,
  type Intersection,
  type Group,
  type MeshBasicMaterial,
  type Object3D,
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
const COMPASS_BAND_HALF_WIDTH = 4.5;
const COMPASS_RIM_POINTS = [
  buildCirclePoints(ORBIT_RING_RADIUS - COMPASS_BAND_HALF_WIDTH, 96),
  buildCirclePoints(ORBIT_RING_RADIUS + COMPASS_BAND_HALF_WIDTH, 96),
];
const COMPASS_TICK_POINTS = buildCompassTickPoints();
/** Compass headings: the in-plane axes, like N/E/S/W on a CAD view cube. */
const COMPASS_HEADINGS: Array<{
  angle: number;
  axis: HudAxisId;
  label: string;
  positive: boolean;
}> = [
  { angle: 0, axis: "x", label: "+X", positive: true },
  { angle: Math.PI / 2, axis: "y", label: "+Y", positive: true },
  { angle: Math.PI, axis: "x", label: "\u2212X", positive: false },
  { angle: Math.PI * 1.5, axis: "y", label: "\u2212Y", positive: false },
];
/** Shading of edge and corner hot zones, so every snap target reads as a part. */
const VIEW_CUBE_ZONE_SHADE: Record<ViewCubeTargetKind, number> = {
  corner: 0.2,
  edge: 0.1,
  face: 0,
};
/** Gap between hot zones; the darker body shows through as a bevel seam. */
const VIEW_CUBE_ZONE_GAP = 1.1;
const VIEW_CUBE_SEAM_SHADE = 0.42;
/** Each cube edge borders two faces; it is drawn while either one is visible. */
const VIEW_CUBE_EDGE_FACES = VIEW_CUBE_EDGE_LINES.map((edge) =>
  viewCubeEdgeFaces(edge.points),
);
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
  const seamColor = useMemo(
    () => mixColor(hud.cubeFace, hud.cubeShade, VIEW_CUBE_SEAM_SHADE),
    [hud],
  );
  const faceGradient = useMemo(() => buildViewCubeFaceGradient(), []);
  const faceGroupsRef = useRef(new Map<string, Group>());
  const edgeRefs = useRef<Array<Object3D | null>>([]);
  const visibility = useMemo(
    () => ({ faces: new Map<string, boolean>(), forward: new Vector3() }),
    [],
  );

  useEffect(() => () => faceGradient.dispose(), [faceGradient]);

  useEffect(() => {
    setCanvasCursor(gl.domElement, hoveredTargetId ? "pointer" : "");
  }, [gl, hoveredTargetId]);
  useEffect(() => () => setCanvasCursor(gl.domElement, ""), [gl]);

  // The HUD draws without depth, so faces turned away and the edges behind
  // the cube are hidden explicitly; otherwise the cube reads as a wireframe.
  useFrame(({ camera: frameCamera }) => {
    const cube = cubeGroupRef.current;
    if (!cube) return;
    viewDirectionTo(cube, frameCamera, visibility.forward);
    for (const face of faces) {
      const facing =
        -(face.normal[0] * visibility.forward.x +
          face.normal[1] * visibility.forward.y +
          face.normal[2] * visibility.forward.z);
      const visible = facing > 0.01;
      visibility.faces.set(face.id, visible);
      const group = faceGroupsRef.current.get(face.id);
      if (group) group.visible = visible;
    }
    VIEW_CUBE_EDGE_FACES.forEach((edgeFaces, index) => {
      const edge = edgeRefs.current[index];
      if (edge) {
        edge.visible = edgeFaces.some((faceId) => visibility.faces.get(faceId));
      }
    });
  });
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
            color={seamColor}
            depthTest={false}
            depthWrite={false}
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
              gradient={faceGradient}
              groupRef={(group) => {
                if (group) faceGroupsRef.current.set(face.id, group);
                else faceGroupsRef.current.delete(face.id);
              }}
              shade={hud.cubeShade}
              faceHovered={faceHovered}
              hud={hud}
              hoveredTargetId={hoveredTargetId}
              onHoverChange={setHoveredTargetId}
              onSnap={onSnap}
            />
          );
        })}
        {VIEW_CUBE_EDGE_LINES.map((edge, index) => (
          <Line
            key={viewCubeSegmentKey(edge.points)}
            ref={(line: Object3D | null) => {
              edgeRefs.current[index] = line;
            }}
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
  const gl = useThree((state) => state.gl);
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
    if (wasDragging) setCanvasCursor(gl.domElement, "");
    detachWindowDragListeners();
    restoreOrbitControls();
    if (wasDragging) {
      onOrbitEndRef.current();
    }
  }, [detachWindowDragListeners, gl, onOrbitEndRef, restoreOrbitControls]);

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

  const hud = resolveHudColors(colors);
  const accent = String(colors.accent);
  const bandColor = hovered ? accent : hud.chip;
  const edgeColor = hovered ? accent : hud.cubeEdge;

  return (
    <group renderOrder={WIDGET_RENDER_ORDER + 1}>
      {/* Wide, invisible hit target around the compass band. */}
      <mesh
        renderOrder={WIDGET_RENDER_ORDER + 1}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          if (!isDragging.current) setCanvasCursor(gl.domElement, "grab");
        }}
        onPointerOut={() => {
          setHovered(false);
          if (!isDragging.current) setCanvasCursor(gl.domElement, "");
        }}
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
          setCanvasCursor(gl.domElement, "grabbing");
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
      {/* Compass band: a flat annulus with rims, ticks and axis headings. */}
      <mesh renderOrder={WIDGET_RENDER_ORDER + 1}>
        <ringGeometry
          args={[
            ORBIT_RING_RADIUS - COMPASS_BAND_HALF_WIDTH,
            ORBIT_RING_RADIUS + COMPASS_BAND_HALF_WIDTH,
            96,
          ]}
        />
        <meshBasicMaterial
          color={bandColor}
          depthTest={false}
          depthWrite={false}
          opacity={hovered ? 0.5 : 0.92}
          side={DoubleSide}
          toneMapped={false}
          transparent
        />
      </mesh>
      {COMPASS_RIM_POINTS.map((points, index) => (
        <Line
          key={index}
          color={edgeColor}
          depthTest={false}
          lineWidth={1.2}
          opacity={0.95}
          points={points}
          renderOrder={WIDGET_RENDER_ORDER + 2}
          transparent
        />
      ))}
      <Line
        color={edgeColor}
        depthTest={false}
        lineWidth={1}
        opacity={0.8}
        points={COMPASS_TICK_POINTS}
        renderOrder={WIDGET_RENDER_ORDER + 2}
        segments
        transparent
      />
      {COMPASS_HEADINGS.map((heading) => (
        <HudTextSprite
          key={heading.label}
          opacity={heading.positive ? 1 : 0.8}
          position={[
            Math.cos(heading.angle) * ORBIT_RING_RADIUS,
            Math.sin(heading.angle) * ORBIT_RING_RADIUS,
            0,
          ]}
          renderOrder={WIDGET_RENDER_ORDER + 6}
          runs={[
            {
              color: hudAxisColor(hud, heading.axis),
              text: heading.label,
              weight: 800,
            },
          ]}
          style={{ font: "ui", fontPx: 10, halo: hovered ? accent : hud.chip, haloPx: 2 }}
        />
      ))}
      {ORBIT_RING_CHEVRON_ANGLES.map((angle) => (
        <mesh
          key={angle}
          position={[
            Math.cos(angle) * ORBIT_RING_RADIUS,
            Math.sin(angle) * ORBIT_RING_RADIUS,
            0,
          ]}
          renderOrder={WIDGET_RENDER_ORDER + 3}
          rotation={[0, 0, angle]}
        >
          <coneGeometry args={[3.2, 7, 3]} />
          <meshBasicMaterial
            color={hovered ? hud.chip : hud.label}
            depthTest={false}
            depthWrite={false}
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
  gradient,
  groupRef,
  hoveredTargetId,
  hud,
  onHoverChange,
  onSnap,
  shade,
}: {
  accent: string;
  face: ViewCubeFaceModel;
  faceColor: string;
  faceHovered: boolean;
  gradient: CanvasTexture;
  groupRef: (group: Group | null) => void;
  shade: string;
  hoveredTargetId: string | null;
  hud: Viewport3DHudColors;
  onHoverChange: (id: string | null) => void;
  onSnap: (direction: Direction3) => void;
}) {
  const placement = VIEW_CUBE_FACE_PLACEMENTS[face.id];
  const label = VIEW_CUBE_FACE_LABELS[face.id];
  const zoneColors = useMemo(
    () => ({
      corner: mixColor(faceColor, shade, VIEW_CUBE_ZONE_SHADE.corner),
      edge: mixColor(faceColor, shade, VIEW_CUBE_ZONE_SHADE.edge),
      face: faceColor,
    }),
    [faceColor, shade],
  );

  return (
    <group
      ref={groupRef}
      position={placement.position}
      rotation={placement.rotation}
    >
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
          zoneColors[targetKind],
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
            <planeGeometry
              args={[
                Math.max(cell.width - VIEW_CUBE_ZONE_GAP, 0.1),
                Math.max(cell.height - VIEW_CUBE_ZONE_GAP, 0.1),
              ]}
            />
            <meshBasicMaterial
              color={cellMaterial.color}
              depthTest={false}
              depthWrite={false}
              map={targetKind === "face" && !isHovered ? gradient : null}
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
      viewDirectionTo(ref.current, camera, scratch.cameraForward);
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

function viewCubeCellMaterial(
  kind: ViewCubeTargetKind,
  hovered: boolean,
  zoneColor: string,
  accent: string,
): { color: string; opacity: number } {
  if (hovered) {
    return { color: accent, opacity: kind === "face" ? 0.55 : 0.9 };
  }
  return { color: zoneColor, opacity: 1 };
}

function mixColor(from: string, to: string, amount: number): string {
  return `#${new Color(from).lerp(new Color(to), amount).getHexString()}`;
}

/** Soft top-lit gradient multiplied into each face centre. */
function buildViewCubeFaceGradient(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(1, "#e3e3e3");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Direction from the camera to an object. The HUD sits in a corner of a
 * perspective view, so the camera axis alone would misjudge which faces
 * of the cube are visible.
 */
function viewDirectionTo(object: Object3D, camera: Camera, out: Vector3): Vector3 {
  object.getWorldPosition(out);
  return out.sub(camera.position).normalize();
}

function setCanvasCursor(element: HTMLElement, cursor: string): void {
  element.style.cursor = cursor;
}

function buildCirclePoints(
  radius: number,
  segments: number,
): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  return points;
}

/** Compass graduation: a tick every 15 deg, longer at the axis headings. */
function buildCompassTickPoints(): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  const outer = ORBIT_RING_RADIUS + COMPASS_BAND_HALF_WIDTH;
  for (let index = 0; index < 24; index += 1) {
    if (index % 6 === 0) continue; // headings carry labels instead
    const angle = (index / 24) * Math.PI * 2;
    const length = index % 3 === 0 ? 3.2 : 1.8;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push([cos * outer, sin * outer, 0], [cos * (outer - length), sin * (outer - length), 0]);
  }
  return points;
}

function viewCubeEdgeFaces(
  points: [[number, number, number], [number, number, number]],
): Array<ViewCubeFaceModel["id"]> {
  const [start, end] = points;
  const faces: Array<ViewCubeFaceModel["id"]> = [];
  // The two coordinates shared by both ends name the adjacent faces.
  if (start[0] === end[0]) faces.push(start[0] > 0 ? "right" : "left");
  if (start[1] === end[1]) faces.push(start[1] > 0 ? "front" : "back");
  if (start[2] === end[2]) faces.push(start[2] > 0 ? "top" : "bottom");
  return faces;
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
