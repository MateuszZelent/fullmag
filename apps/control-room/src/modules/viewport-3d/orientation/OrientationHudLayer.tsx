"use client";

import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, memo, type ReactNode } from "react";
import {
  BufferAttribute,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Group,
  type Object3D,
  type Sprite,
} from "three";

import { viewport3dStore } from "../viewport3dStore";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  Viewport3DCameraState,
  Viewport3DRotationMode,
} from "../viewport3dStore";
import type { Viewport3DColors, Viewport3DHudColors } from "../viewport3dTypes";
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
  magnetizationHslLinearRgb,
} from "./magnetizationColor";
import {
  ORBIT_SENSITIVITY,
  WIDGET_CAMERA_DISTANCE,
  WIDGET_RENDER_ORDER,
} from "./orientationHudConstants";
import { resolveHudColors } from "./hudColors";
import { HudTextSprite } from "./hudText";
import {
  ViewCube3DBox,
  type ViewportCameraControlsHandle,
} from "./ViewCube3DBox";

interface OrientationHudLayerProps {
  colors: Viewport3DColors;
  hslReferenceVisible: boolean;
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  rotationMode: Viewport3DRotationMode;
  tracker: Viewport3DResourceTracker;
  viewCubeVisible: boolean;
}

interface AnchorVectors {
  center: Vector3;
  forward: Vector3;
  position: Vector3;
  right: Vector3;
  up: Vector3;
}

export const OrientationHudLayer = memo(function OrientationHudLayer({
  colors,
  hslReferenceVisible,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  rotationMode,
  tracker,
  viewCubeVisible,
}: OrientationHudLayerProps) {
  const camera = useThree((state) => state.camera);
  const invalidate = useBatchedInvalidate("camera");
  const controls = useThree((state) =>
    "controls" in state
      ? (state.controls as ViewportCameraControlsHandle | undefined)
      : undefined,
  );
  const pendingOrbitCameraRef = useRef<Viewport3DCameraState | null>(null);
  const controlsTargetRef = useRef(new Vector3());
  const commitCameraChange = useCallback(
    (nextCamera: Viewport3DCameraState) => {
      onCameraInteractionStart?.();
      void Promise.resolve(onCameraChange(nextCamera))
        .catch(() => undefined)
        .finally(() => onCameraInteractionEnd?.());
    },
    [onCameraChange, onCameraInteractionEnd, onCameraInteractionStart],
  );
  const getCurrentCamera = useCallback(
    () => {
      const controlsTarget = controls?.getTarget
        ? controls.getTarget(controlsTargetRef.current, false).toArray()
        : controls?.target?.toArray();
      return resolveViewCubeCurrentCameraState({
        cameraPosition: camera.position.toArray() as [number, number, number],
        cameraState: viewport3dStore.getSnapshot().camera,
        cameraUp: camera.up.toArray() as [number, number, number],
        controlsTarget: controlsTarget as
          | [number, number, number]
          | undefined,
      });
    },
    [camera, controls],
  );
  const applyLiveCamera = useCallback(
    (nextCamera: Viewport3DCameraState) => {
      camera.up.set(...nextCamera.up);
      camera.position.set(...nextCamera.position);
      camera.lookAt(...nextCamera.target);
      camera.updateProjectionMatrix();
      if (controls?.setLookAt) {
        void controls
          .setLookAt(
            nextCamera.position[0],
            nextCamera.position[1],
            nextCamera.position[2],
            nextCamera.target[0],
            nextCamera.target[1],
            nextCamera.target[2],
            false,
          )
          .catch(() => undefined);
      } else {
        controls?.target?.set(...nextCamera.target);
      }
      controls?.update?.(0);
    },
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

      applyLiveCamera(nextCamera);
      commitCameraChange(nextCamera);
      tracker.recordDirtyFrame("orientation-hud-snap");
      invalidate();
    },
    [applyLiveCamera, commitCameraChange, getCurrentCamera, invalidate, rotationMode, tracker],
  );

  const onOrbit = useCallback(
    (deltaX: number) => {
      const currentCamera = getCurrentCamera();
      const nextCamera = {
        ...(rotationMode === "camera"
          ? rotateFreeCameraTarget(currentCamera, deltaX, ORBIT_SENSITIVITY)
          : orbitCameraAroundTarget(currentCamera, deltaX, ORBIT_SENSITIVITY)),
      };

      applyLiveCamera(nextCamera);
      if (!pendingOrbitCameraRef.current) {
        onCameraInteractionStart?.();
      }
      pendingOrbitCameraRef.current = nextCamera;
      tracker.recordDirtyFrame("orientation-hud-orbit");
      invalidate();
    },
    [
      applyLiveCamera,
      getCurrentCamera,
      invalidate,
      onCameraInteractionStart,
      rotationMode,
      tracker,
    ],
  );
  const commitOrbit = useCallback(() => {
    const nextCamera = pendingOrbitCameraRef.current;
    if (!nextCamera) {
      onCameraInteractionEnd?.();
      return;
    }
    pendingOrbitCameraRef.current = null;
    void Promise.resolve(onCameraChange(nextCamera))
      .catch(() => undefined)
      .finally(() => onCameraInteractionEnd?.());
  }, [onCameraChange, onCameraInteractionEnd]);

  useEffect(
    () => () => {
      if (pendingOrbitCameraRef.current) {
        pendingOrbitCameraRef.current = null;
        onCameraInteractionEnd?.();
      }
    },
    [onCameraInteractionEnd],
  );

  if (!viewCubeVisible && !hslReferenceVisible) {
    return null;
  }

  return (
    <>
      {viewCubeVisible ? (
        <ScreenAnchoredGroup
          anchor="viewCube"
          pixelScale={1.15}
          tracker={tracker}
        >
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
        <ScreenAnchoredGroup
          anchor="hslReference"
          pixelScale={1}
          tracker={tracker}
        >
          <HslReferenceSphere colors={colors} />
        </ScreenAnchoredGroup>
      ) : null}
    </>
  );
})

function ScreenAnchoredGroup({
  anchor,
  children,
  pixelScale,
  tracker,
}: {
  anchor: keyof ReturnType<typeof resolveOrientationHudAnchors>;
  children: ReactNode;
  pixelScale: number;
  tracker: Viewport3DResourceTracker;
}) {
  const ref = useRef<Group>(null);
  const camera = useThree((state) => state.camera);
  const invalidate = useBatchedInvalidate("resize");
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
    tracker.recordDirtyFrame("orientation-hud-mounted");
    invalidate();
  }, [invalidate, tracker]);

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

const HSL_SPHERE_RADIUS_PX = 40;
const HSL_AXIS_REACH = 1.38;
const HSL_TIP_LENGTH_PX = 7;
const HSL_CHIP_GAP_PX = 19;
/** Projected axis length (fraction of the radius) below which it is end-on. */
const HSL_END_ON_THRESHOLD = 0.3;
const HSL_SPHERE_ORDER = WIDGET_RENDER_ORDER;
const HSL_EQUATOR_POINTS = buildHalfCirclePoints(48);
// Chip slots for end-on axes, chosen so two end-on cases never collide.
const HSL_END_ON_CHIP_SLOTS: Record<string, [number, number]> = {
  x: [0.72, 0.72],
  y: [-0.72, 0.72],
  z: [0.72, -0.72],
};

function HslReferenceSphere({ colors }: { colors: Viewport3DColors }) {
  const geometry = useMemo(() => buildHslSphereGeometry(), []);
  const hud = useMemo(() => resolveHudColors(colors), [colors]);
  const equatorRef = useRef<Group>(null);
  const rimRef = useRef<Object3D>(null);
  const forward = useMemo(() => new Vector3(), []);
  const chipLayout = useMemo(() => new Map<string, HslChipSlot>(), []);
  const chipAxes = useMemo(() => ({ right: new Vector3(), up: new Vector3() }), []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  // Only the camera-facing half of the equator is drawn (the HUD ignores
  // depth), so turn the half circle towards the viewer every frame.
  useFrame(({ camera }) => {
    // Children subscribe first, so every axis has reported its chip here.
    placeHslChips(chipLayout, camera, chipAxes);
    // Face the rim and the equator towards the camera position: the HUD sits
    // off-axis in a perspective view, so the camera axis is slightly off.
    rimRef.current?.lookAt(camera.position);
    if (!equatorRef.current) return;
    equatorRef.current.getWorldPosition(forward).sub(camera.position).normalize();
    // Looking along z the equator is the silhouette, which the rim draws.
    const inPlane = Math.hypot(forward.x, forward.y);
    equatorRef.current.visible = inPlane > 0.15;
    if (inPlane > 0.15) {
      equatorRef.current.rotation.z = Math.atan2(-forward.y, -forward.x);
    }
  });

  return (
    <group>
      <group scale={[HSL_SPHERE_RADIUS_PX, HSL_SPHERE_RADIUS_PX, HSL_SPHERE_RADIUS_PX]}>
        {/* Rim: a camera-facing ring around the silhouette. It never covers
            the sphere, so the legend colours stay exact. */}
        <mesh ref={rimRef} renderOrder={HSL_SPHERE_ORDER + 1}>
          <ringGeometry args={[1, 1.035, 72]} />
          <meshBasicMaterial
            color={hud.label}
            depthTest={false}
            depthWrite={false}
            opacity={0.5}
            toneMapped={false}
            transparent
          />
        </mesh>
        {/* Vertex-coloured HSL sphere. All parts are "transparent" so they
            share one render list and renderOrder alone decides layering,
            e.g. shafts of axes pointing away are drawn beneath the sphere. */}
        <mesh geometry={geometry} renderOrder={HSL_SPHERE_ORDER}>
          <meshBasicMaterial
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
            transparent
            vertexColors
          />
        </mesh>
        {/* m_z = 0: the lightness-0.5 boundary between the hemispheres. */}
        <group ref={equatorRef}>
          <Line
            color={hud.cubeShade}
            depthTest={false}
            lineWidth={1}
            opacity={0.45}
            points={HSL_EQUATOR_POINTS}
            renderOrder={HSL_SPHERE_ORDER + 1}
            transparent
          />
        </group>
      </group>
      {HSL_REFERENCE_AXES.map((axis) => (
        <HslReferenceAxis
          key={axis.id}
          chipLayout={chipLayout}
          color={rgbCss(axis.color)}
          direction={axis.direction}
          hud={hud}
          id={axis.id}
        />
      ))}
    </group>
  );
}

function HslReferenceAxis({
  chipLayout,
  color,
  direction,
  hud,
  id,
}: {
  chipLayout: Map<string, HslChipSlot>;
  color: string;
  direction: readonly [number, number, number];
  hud: Viewport3DHudColors;
  id: string;
}) {
  const shaftRefs = useRef<Array<Object3D | null>>([]);
  const tipRefs = useRef<Array<Object3D | null>>([]);
  const chipRef = useRef<Sprite>(null);
  const towardRef = useRef<Sprite>(null);
  const awayRef = useRef<Sprite>(null);
  const scratch = useMemo(
    () => ({ forward: new Vector3(), right: new Vector3(), up: new Vector3() }),
    [],
  );
  const end = scaleDirection(direction, HSL_SPHERE_RADIUS_PX * HSL_AXIS_REACH);
  const tip = scaleDirection(
    direction,
    HSL_SPHERE_RADIUS_PX * HSL_AXIS_REACH + HSL_TIP_LENGTH_PX / 2,
  );
  const markerStyle = { font: "ui", fontPx: 13, halo: hud.halo } as const;

  useFrame(({ camera }) => {
    const { forward, right, up } = scratch;
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const along = direction[0] * forward.x + direction[1] * forward.y + direction[2] * forward.z;
    const dx = direction[0] * right.x + direction[1] * right.y + direction[2] * right.z;
    const dy = direction[0] * up.x + direction[1] * up.y + direction[2] * up.z;
    const projected = Math.hypot(dx, dy);
    const away = along > 0;
    const endOn = projected < HSL_END_ON_THRESHOLD;

    // Axes pointing away render beneath the sphere, which then hides the
    // part of the shaft that is behind it.
    const shaftOrder = away ? HSL_SPHERE_ORDER - 3 : HSL_SPHERE_ORDER + 2;
    for (const shaft of shaftRefs.current) {
      if (shaft) shaft.renderOrder = shaftOrder;
    }
    for (let index = 0; index < tipRefs.current.length; index += 1) {
      const tipMesh = tipRefs.current[index];
      if (tipMesh) tipMesh.renderOrder = shaftOrder + 1 + index;
    }

    if (towardRef.current) towardRef.current.visible = endOn && !away;
    if (awayRef.current) awayRef.current.visible = endOn && away;
    const chip = chipRef.current;
    if (!chip) return;
    const slot = HSL_END_ON_CHIP_SLOTS[id] ?? [0.72, 0.72];
    let offsetRight = slot[0] * HSL_SPHERE_RADIUS_PX * 1.25;
    let offsetUp = slot[1] * HSL_SPHERE_RADIUS_PX * 1.25;
    if (!endOn) {
      const distance =
        projected * HSL_SPHERE_RADIUS_PX * HSL_AXIS_REACH +
        HSL_TIP_LENGTH_PX +
        HSL_CHIP_GAP_PX;
      offsetRight = (dx / projected) * distance;
      offsetUp = (dy / projected) * distance;
    }
    // The sphere resolves overlaps between chips after all axes report.
    const slotState = chipLayout.get(id) ?? { priority: 0, sprite: chip, x: 0, y: 0 };
    slotState.priority = endOn ? 0 : projected;
    slotState.sprite = chip;
    slotState.x = offsetRight;
    slotState.y = offsetUp;
    chipLayout.set(id, slotState);
    (chip.material as { opacity: number }).opacity = away ? 0.8 : 1;
  });

  return (
    <group>
      <Line
        ref={(line: Object3D | null) => {
          shaftRefs.current[0] = line;
        }}
        color={hud.halo}
        depthTest={false}
        lineWidth={4.5}
        points={[[0, 0, 0], end]}
        renderOrder={HSL_SPHERE_ORDER + 2}
        transparent
      />
      <Line
        ref={(line: Object3D | null) => {
          shaftRefs.current[1] = line;
        }}
        color={hud.label}
        depthTest={false}
        lineWidth={1.8}
        points={[[0, 0, 0], end]}
        renderOrder={HSL_SPHERE_ORDER + 2}
        transparent
      />
      {/* Tip in the true HSL colour, outlined so +z (white) shows on Latte. */}
      <mesh
        ref={(mesh) => {
          tipRefs.current[0] = mesh;
        }}
        position={tip}
        renderOrder={HSL_SPHERE_ORDER + 3}
        rotation={axisTipRotation(id)}
      >
        <coneGeometry args={[4.6, HSL_TIP_LENGTH_PX + 2.4, 20]} />
        <meshBasicMaterial
          color={hud.label}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
          transparent
        />
      </mesh>
      <mesh
        ref={(mesh) => {
          tipRefs.current[1] = mesh;
        }}
        position={tip}
        renderOrder={HSL_SPHERE_ORDER + 4}
        rotation={axisTipRotation(id)}
      >
        <coneGeometry args={[3.4, HSL_TIP_LENGTH_PX, 20]} />
        <meshBasicMaterial
          color={color}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
          transparent
        />
      </mesh>
      <HudTextSprite
        ref={chipRef}
        position={[0, 0, 0]}
        renderOrder={HSL_SPHERE_ORDER + 8}
        runs={[
          { color: hud.label, text: "+" },
          { color: hud.label, italic: true, text: id },
        ]}
        style={{
          chip: { border: hud.chipBorder, fill: hud.chip, swatch: color },
          font: "ui",
          fontPx: 11,
          halo: hud.halo,
        }}
      />
      <HudTextSprite
        ref={towardRef}
        position={[0, 0, 0]}
        renderOrder={HSL_SPHERE_ORDER + 7}
        runs={[{ color: hud.label, text: "⊙" }]}
        style={markerStyle}
      />
      <HudTextSprite
        ref={awayRef}
        position={[0, 0, 0]}
        renderOrder={HSL_SPHERE_ORDER + 7}
        runs={[{ color: hud.label, text: "⊗" }]}
        style={markerStyle}
      />
    </group>
  );
}

interface HslChipSlot {
  /** Larger keeps its place; end-on axes yield first. */
  priority: number;
  sprite: Sprite;
  x: number;
  y: number;
}

const HSL_CHIP_CLEARANCE_X = 38;
const HSL_CHIP_CLEARANCE_Y = 20;

/** Places the axis chips, nudging lower-priority chips off overlaps. */
function placeHslChips(
  layout: Map<string, HslChipSlot>,
  camera: Camera,
  axes: { right: Vector3; up: Vector3 },
): void {
  const slots = [...layout.values()].sort((a, b) => b.priority - a.priority);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let fixed = 0; fixed < slots.length; fixed += 1) {
      for (let moving = fixed + 1; moving < slots.length; moving += 1) {
        const anchor = slots[fixed];
        const slot = slots[moving];
        if (!anchor || !slot) continue;
        const dx = slot.x - anchor.x;
        const dy = slot.y - anchor.y;
        if (Math.abs(dx) >= HSL_CHIP_CLEARANCE_X || Math.abs(dy) >= HSL_CHIP_CLEARANCE_Y) {
          continue;
        }
        slot.y = anchor.y + (dy >= 0 ? 1 : -1) * HSL_CHIP_CLEARANCE_Y;
      }
    }
  }
  axes.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  axes.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  for (const slot of slots) {
    slot.sprite.position
      .set(0, 0, 0)
      .addScaledVector(axes.right, slot.x)
      .addScaledVector(axes.up, slot.y);
  }
}

function buildHalfCirclePoints(segments: number): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = -Math.PI / 2 + (Math.PI * index) / segments;
    points.push([Math.cos(angle) * 1.002, Math.sin(angle) * 1.002, 0]);
  }
  return points;
}

function buildHslSphereGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(1, 40, 24);
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);

  for (let index = 0; index < position.count; index += 1) {
    // Linear-sRGB: this array becomes a `color` buffer attribute, which
    // three.js reads as working-space (linear) data. Uploading the sRGB code
    // values made the legend sphere noticeably paler than the field it is
    // meant to explain. See viewport3dColorSpace.ts.
    const [red, green, blue] = magnetizationHslLinearRgb(
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
  camera.updateMatrixWorld(true);
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
