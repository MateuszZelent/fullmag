import { DEFAULT_VIEWPORT_3D_CAMERA_STATE, viewport3dStore, type Viewport3DCameraProjection, type Viewport3DCameraState } from "../viewport3dStore";
import { viewport3DCameraSnapshotsEqual, type Viewport3DLiveCameraSnapshot } from "./viewport3DCameraState";
import { VIEWPORT_3D_WORLD_UP } from "../viewport3dCameraModel";
import { nearTuple3, sameTuple3 } from "../viewport3dMath";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import { DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES, resolveViewport3DCameraFovDegrees } from "../viewport3dCameraFov";
import { MathUtils, type Camera } from "three";
import { resolveViewport3DCameraDepthRange } from "./viewport3DCameraClip";
import type { ComponentRef } from "react";
import { OrbitControls as DreiOrbitControls } from "@react-three/drei";

interface Viewport3DCameraFit {
  far: number;
  near: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface Viewport3DCameraChange extends Viewport3DCameraState {
  orthographicScale?: number | null;
  projection?: Viewport3DCameraProjection;
}

export interface Viewport3DOrbitDebugAngles {
  azimuth: number;
  polar: number;
}

export type OrbitControlsHandle = ComponentRef<typeof DreiOrbitControls>;

interface Viewport3DCameraInteractionOptions {
  dampingFactor: number;
  enableDamping: boolean;
  enablePan: boolean;
  enableRotate: boolean;
  enableZoom: boolean;
  panSpeed: number;
  rotateSpeed: number;
  zoomSpeed: number;
}

export const FALLBACK_CAMERA_BOUNDS: Viewport3DBounds = {
  center: [0, 0, 0],
  radius: 1e-6,
  size: [1e-6, 1e-6, 1e-6],
};

const ORBIT_TARGET_SYNC_EPSILON = 1e-12;

const ORBIT_DEBUG_ANGLE_EPSILON = 1e-6;

const ORBIT_DEBUG_DAMPING = 18;

export const ORBIT_DEBUG_TWO_PI = Math.PI * 2;

export const VIEWPORT_3D_ORBIT_DEBUG_LIMITS = {
  azimuthMax: ORBIT_DEBUG_TWO_PI,
  azimuthMin: 0,
  polarMax: Math.PI,
  polarMin: 0,
} as const;

const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  dampingFactor: 0.08,
  enableDamping: true,
  enablePan: true,
  enableRotate: true,
  enableZoom: true,
  panSpeed: 2,
  rotateSpeed: 1,
  zoomSpeed: 1,
} satisfies Viewport3DCameraInteractionOptions;

// three-stdlib OrbitControls uses a fixed squared world-distance threshold
// for change events. SI nanometre translations fall below that threshold even
// while the controls update their camera. Preserve its input/damping ownership
// and supply only the missing notification needed by the demand renderer.
export function installScaleAwareOrbitChange(
  controls: OrbitControlsHandle,
  sceneRadius: number,
  interactionActive: () => boolean,
  observeMotion: (moving: boolean) => void,
  dampingTailActive: () => boolean = () => false,
): () => void {
  const originalUpdate = controls.update;
  const lastPosition = controls.object.position.clone();
  const lastTarget = controls.target.clone();
  const epsilon = Math.max(Math.abs(sceneRadius), 1e-18) * 1e-8;
  let nativeChange = false;
  let updating = false;
  let previousUpdateAt = performance.now();
  let wasDampingTail = false;
  const observeNativeChange = () => {
    if (updating) nativeChange = true;
  };
  controls.addEventListener("change", observeNativeChange);
  const update: typeof controls.update = (...args) => {
    nativeChange = false;
    updating = true;
    let result: ReturnType<typeof originalUpdate>;
    const now = performance.now();
    const dampingTail = interactionActive() && dampingTailActive();
    const baseDamping = controls.dampingFactor;
    if (controls.enableDamping && dampingTail && wasDampingTail && baseDamping > 0 && baseDamping < 1) {
      // Keep dragging unchanged. After release, compose the normal 60 Hz decay
      // over elapsed time so slow frames do not leave a minute-long tail.
      const elapsedSeconds = Math.min(0.25, Math.max(1 / 60, (now - previousUpdateAt) / 1000));
      controls.dampingFactor = 1 - (1 - baseDamping) ** (elapsedSeconds * 60);
    }
    previousUpdateAt = now;
    wasDampingTail = dampingTail;
    try {
      result = originalUpdate.apply(controls, args);
    } finally {
      controls.dampingFactor = baseDamping;
      updating = false;
    }
    const moved = lastPosition.distanceToSquared(controls.object.position) > epsilon * epsilon ||
      lastTarget.distanceToSquared(controls.target) > epsilon * epsilon;
    observeMotion(moved || nativeChange);
    // Keep the last significant pose, so subthreshold damping cannot keep a
    // demand frame alive indefinitely and small deltas can still accumulate.
    if (moved || nativeChange || !interactionActive()) {
      lastPosition.copy(controls.object.position);
      lastTarget.copy(controls.target);
    }
    if (moved && !nativeChange && interactionActive()) {
      controls.dispatchEvent({ type: "change", target: controls });
      return true;
    }
    return result;
  };
  controls.update = update;
  return () => {
    controls.removeEventListener("change", observeNativeChange);
    if (controls.update === update) controls.update = originalUpdate;
  };
}

export function resolveViewport3DCameraInteractionOptions(
  overrides?: { rotateLocked?: boolean },
): Viewport3DCameraInteractionOptions {
  if (!overrides?.rotateLocked) {
    return VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS;
  }
  return {
    ...VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS,
    enableRotate: false,
  };
}

export function shouldSyncCameraControlsPose({
  currentPosition,
  currentTarget,
  nextCameraState,
}: {
  currentPosition: readonly number[];
  currentTarget: readonly number[];
  nextCameraState: Viewport3DCameraState;
}): boolean {
  return (
    !nearTuple3(
      tuple3(currentPosition),
      nextCameraState.position,
      ORBIT_TARGET_SYNC_EPSILON,
    ) ||
    !nearTuple3(
      tuple3(currentTarget),
      nextCameraState.target,
      ORBIT_TARGET_SYNC_EPSILON,
    )
  );
}

export function normalizeViewport3DOrbitDebugAngles(
  angles: Partial<Viewport3DOrbitDebugAngles> | null | undefined,
): Viewport3DOrbitDebugAngles {
  return {
    azimuth: clampOrbitDebugAngle(
      angles?.azimuth,
      VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin,
      VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMax,
      0,
    ),
    polar: clampOrbitDebugAngle(
      angles?.polar,
      VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMin,
      VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMax,
      Math.PI / 2,
    ),
  };
}

export function shouldApplyViewport3DOrbitDebugAngles(
  currentAngles: Viewport3DOrbitDebugAngles | null,
  nextAngles: Viewport3DOrbitDebugAngles,
): boolean {
  if (!currentAngles) return true;
  return (
    Math.abs(shortestOrbitDebugAzimuthDelta(currentAngles.azimuth, nextAngles.azimuth)) >
      ORBIT_DEBUG_ANGLE_EPSILON ||
    Math.abs(currentAngles.polar - nextAngles.polar) >
      ORBIT_DEBUG_ANGLE_EPSILON
  );
}

export function resolveViewport3DOrbitDebugStep({
  currentAngles,
  deltaSeconds,
  targetAngles,
}: {
  currentAngles: Viewport3DOrbitDebugAngles;
  deltaSeconds: number;
  targetAngles: Viewport3DOrbitDebugAngles;
}): Viewport3DOrbitDebugAngles {
  if (!shouldApplyViewport3DOrbitDebugAngles(currentAngles, targetAngles)) {
    return targetAngles;
  }
  const safeDelta = Math.min(Math.max(deltaSeconds, 0), 0.05);
  const dampingFactor = 1 - Math.exp(-ORBIT_DEBUG_DAMPING * safeDelta);
  const nextAngles = {
    azimuth: clampOrbitDebugAngle(
      currentAngles.azimuth +
        shortestOrbitDebugAzimuthDelta(
          currentAngles.azimuth,
          targetAngles.azimuth,
        ) *
          dampingFactor,
      VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin,
      VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMax,
      currentAngles.azimuth,
    ),
    polar: MathUtils.damp(
      currentAngles.polar,
      targetAngles.polar,
      ORBIT_DEBUG_DAMPING,
      safeDelta,
    ),
  };
  return shouldApplyViewport3DOrbitDebugAngles(nextAngles, targetAngles)
    ? nextAngles
    : targetAngles;
}

export function resolveViewport3DOrbitDebugControlDeltas({
  currentAngles,
  targetAngles,
}: {
  currentAngles: Viewport3DOrbitDebugAngles;
  targetAngles: Viewport3DOrbitDebugAngles;
}): { azimuth: number; polar: number } {
  return {
    azimuth: shortestOrbitDebugAzimuthDelta(
      currentAngles.azimuth,
      targetAngles.azimuth,
    ),
    polar: targetAngles.polar - currentAngles.polar,
  };
}

export function commitOrbitCameraEnd({
  cameraPosition,
  controlTarget,
  epoch,
  onCameraChange,
  orthographicScale,
  projection,
  syncStore = true,
}: {
  cameraPosition: [number, number, number];
  controlTarget: number[];
  epoch?: number;
  onCameraChange: (
    camera: Viewport3DCameraChange,
    epoch?: number,
  ) => Promise<void> | void;
  orthographicScale?: number | null;
  projection?: Viewport3DCameraProjection;
  syncStore?: boolean;
}): void {
  if (controlTarget.length < 3) return;

  const nextCamera: Viewport3DCameraChange = {
    position: cameraPosition,
    target: tuple3(controlTarget),
    up: VIEWPORT_3D_WORLD_UP,
    ...(orthographicScale === undefined ? {} : { orthographicScale }),
    ...(projection === undefined ? {} : { projection }),
  };
  if (syncStore) {
    if (orthographicScale === undefined || projection === undefined) {
      viewport3dStore.setCamera(nextCamera);
    } else {
      viewport3dStore.setCameraView({
        camera: nextCamera,
        orthographicScale,
        projection,
      });
    }
  }
  const changeResult =
    epoch === undefined
      ? onCameraChange(nextCamera)
      : onCameraChange(nextCamera, epoch);
  void Promise.resolve(changeResult).catch(() => undefined);
}

export function applyViewport3DWorldUp(camera: Camera): void {
  camera.up.set(...VIEWPORT_3D_WORLD_UP);
}

export function resolveViewport3DCameraFit(
  bounds: Viewport3DBounds | null,
  {
    aspect = 1,
    fovDegrees = DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES,
  }: { aspect?: number; fovDegrees?: number } = {},
): Viewport3DCameraFit {
  const activeBounds = bounds ?? FALLBACK_CAMERA_BOUNDS;
  const [x, y, z] = activeBounds.center;
  const radius = Math.max(activeBounds.radius, 1e-12);
  const resolvedFov = resolveViewport3DCameraFovDegrees(fovDegrees);
  const safeAspect =
    Number.isFinite(aspect) && aspect > 0
      ? MathUtils.clamp(aspect, 1e-3, 1e3)
      : 1;
  const verticalHalfFov = MathUtils.degToRad(resolvedFov / 2);
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * safeAspect,
  );
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const cameraDistance =
    (radius * CAMERA_FIT_MARGIN) / Math.sin(limitingHalfFov);
  const distance = cameraDistance / CAMERA_FIT_OFFSET_LENGTH;
  const { near, far } = resolveViewport3DCameraDepthRange(
    activeBounds,
    { x: x + distance, y: y + distance * 0.72, z: z + distance },
    { x: -distance, y: -distance * 0.72, z: -distance },
    cameraDistance,
  );

  return {
    far,
    near,
    position: [
      x + distance,
      y + distance * 0.72,
      z + distance,
    ],
    target: [
      activeBounds.center[0],
      activeBounds.center[1],
      activeBounds.center[2],
    ],
  };
}

const CAMERA_FIT_OFFSET_LENGTH = Math.hypot(1, 0.72, 1);

// Preserve the existing 2.8-radius default fit at 42 degrees and square aspect.
const CAMERA_FIT_MARGIN =
  2.8 * CAMERA_FIT_OFFSET_LENGTH * Math.sin(
    MathUtils.degToRad(DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES / 2),
  );

export function resolveViewport3DAutoFitOrbitTarget({
  cameraState,
  currentPosition,
  fit,
}: {
  cameraState: Viewport3DCameraState;
  currentPosition: [number, number, number];
  fit: Viewport3DCameraFit | null;
}): [number, number, number] | null {
  // Only adopt a target for the exact fit already applied by CameraController.
  // An authored pose or a position moved by a gesture must keep its own target.
  return fit && isDefaultCameraState(cameraState) &&
    sameTuple3(currentPosition, fit.position) ? fit.target : null;
}

function nearCameraState(
  left: Viewport3DCameraState,
  right: Viewport3DCameraState,
): boolean {
  return viewport3DCameraSnapshotsEqual(
    cameraStateSnapshot(left),
    cameraStateSnapshot(right),
  );
}

function cameraStateSnapshot(
  cameraState: Viewport3DCameraState,
): Viewport3DLiveCameraSnapshot {
  return {
    orthographicScale: null,
    position: cameraState.position,
    projection: "perspective",
    target: cameraState.target,
    up: cameraState.up ?? VIEWPORT_3D_WORLD_UP,
  };
}

export function shouldApplyViewport3DCameraState<TCamera>({
  appliedCamera,
  appliedCameraState,
  currentCamera,
  nextCameraState,
}: {
  appliedCamera: TCamera | null;
  appliedCameraState: Viewport3DCameraState | null;
  currentCamera: TCamera;
  nextCameraState: Viewport3DCameraState;
}): boolean {
  return (
    appliedCamera !== currentCamera ||
    !appliedCameraState ||
    !nearCameraState(appliedCameraState, nextCameraState)
  );
}

export function isDefaultCameraState(cameraState: Viewport3DCameraState): boolean {
  return (
    sameTuple3(cameraState.position, DEFAULT_VIEWPORT_3D_CAMERA_STATE.position) &&
    sameTuple3(cameraState.target, DEFAULT_VIEWPORT_3D_CAMERA_STATE.target)
  );
}

export function shouldPreserveViewport3DAutoFitAgainstDefaultCamera({
  appliedCameraState,
  autoFittedBoundsSignature,
  cameraState,
  lastAutoFitCameraState,
}: {
  appliedCameraState: Viewport3DCameraState | null;
  autoFittedBoundsSignature: string | null;
  cameraState: Viewport3DCameraState;
  lastAutoFitCameraState: Viewport3DCameraState | null;
}): boolean {
  return Boolean(
    autoFittedBoundsSignature &&
      appliedCameraState &&
      lastAutoFitCameraState &&
      isDefaultCameraState(cameraState) &&
      nearCameraState(appliedCameraState, lastAutoFitCameraState) &&
      !isDefaultCameraState(lastAutoFitCameraState),
  );
}

export function shouldAutoFitViewport3DBoundsChange({
  currentCameraState,
  lastAutoFitCameraState,
  nextBoundsSignature,
  previousBoundsSignature,
}: {
  currentCameraState: Viewport3DCameraState;
  lastAutoFitCameraState: Viewport3DCameraState | null;
  nextBoundsSignature: string | null;
  previousBoundsSignature: string | null;
}): boolean {
  return Boolean(
    nextBoundsSignature &&
      previousBoundsSignature &&
      nextBoundsSignature !== previousBoundsSignature &&
      lastAutoFitCameraState &&
      nearCameraState(currentCameraState, lastAutoFitCameraState),
  );
}

export function tuple3(values: readonly number[]): [number, number, number] {
  return [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
  ];
}

function clampOrbitDebugAngle(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function shortestOrbitDebugAzimuthDelta(from: number, to: number): number {
  const rawDelta = to - from;
  const wrappedDelta =
    ((rawDelta + Math.PI) % ORBIT_DEBUG_TWO_PI + ORBIT_DEBUG_TWO_PI) %
      ORBIT_DEBUG_TWO_PI -
    Math.PI;
  if (
    Math.abs(wrappedDelta + Math.PI) <= ORBIT_DEBUG_ANGLE_EPSILON &&
    rawDelta > 0
  ) {
    return Math.PI;
  }
  return wrappedDelta;
}
