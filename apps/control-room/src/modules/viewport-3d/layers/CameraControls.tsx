"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef } from "react";
import { MathUtils, MOUSE, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { nearTuple3, sameTuple3 } from "../viewport3dMath";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
} from "../viewport3dStore";

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

type OrbitControlsHandle = ComponentRef<typeof OrbitControls> & {
  getAzimuthalAngle?: () => number;
  getPolarAngle?: () => number;
  rotateLeft?: (angle: number) => void;
  rotateUp?: (angle: number) => void;
};

type OrbitMouseAction = (typeof MOUSE)[keyof typeof MOUSE];

interface Viewport3DCameraInteractionOptions {
  enableDamping: false;
  enablePan: true;
  enableZoom: true;
  mouseButtons: {
    LEFT: OrbitMouseAction;
    MIDDLE: OrbitMouseAction;
    RIGHT: OrbitMouseAction;
  };
  panSpeed: number;
  rotateSpeed: number;
  screenSpacePanning: true;
}

const FALLBACK_CAMERA_BOUNDS: Viewport3DBounds = {
  center: [0, 0, 0],
  radius: 1e-6,
  size: [1e-6, 1e-6, 1e-6],
};
export const VIEWPORT_3D_WORLD_UP: [number, number, number] = [0, 0, 1];
const CAMERA_STATE_EPSILON = 1e-7;
const ORBIT_TARGET_SYNC_EPSILON = 1e-12;
const ORBIT_DEBUG_ANGLE_EPSILON = 1e-6;
const ORBIT_DEBUG_DAMPING = 18;
const ORBIT_DEBUG_TWO_PI = Math.PI * 2;
export const VIEWPORT_3D_ORBIT_DEBUG_LIMITS = {
  azimuthMax: ORBIT_DEBUG_TWO_PI,
  azimuthMin: 0,
  polarMax: Math.PI,
  polarMin: 0,
} as const;

const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  enableDamping: false,
  enablePan: true,
  enableZoom: true,
  mouseButtons: {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  },
  panSpeed: 1,
  rotateSpeed: 1,
  screenSpacePanning: true,
} satisfies Viewport3DCameraInteractionOptions;

export function resolveViewport3DCameraInteractionOptions(): Viewport3DCameraInteractionOptions {
  return VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS;
}

export function shouldSyncOrbitControlsTarget(
  currentTarget: readonly number[],
  nextTarget: readonly number[],
): boolean {
  return !nearTuple3(
    tuple3(currentTarget),
    tuple3(nextTarget),
    ORBIT_TARGET_SYNC_EPSILON,
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

function readViewport3DOrbitDebugAngles(
  controls: OrbitControlsHandle | null,
): Viewport3DOrbitDebugAngles | null {
  if (!controls?.getAzimuthalAngle || !controls.getPolarAngle) return null;
  return normalizeViewport3DOrbitDebugAngles({
    azimuth: normalizeOrbitDebugAzimuthFromControls(
      controls.getAzimuthalAngle(),
    ),
    polar: controls.getPolarAngle(),
  });
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
}): { rotateLeft: number; rotateUp: number } {
  return {
    rotateLeft: -shortestOrbitDebugAzimuthDelta(
      currentAngles.azimuth,
      targetAngles.azimuth,
    ),
    rotateUp: currentAngles.polar - targetAngles.polar,
  };
}

function applyViewport3DOrbitDebugControlAngles({
  controls,
  targetAngles,
}: {
  controls: OrbitControlsHandle;
  targetAngles: Viewport3DOrbitDebugAngles;
}): boolean {
  if (!controls.rotateLeft || !controls.rotateUp) return false;
  const currentAngles = readViewport3DOrbitDebugAngles(controls);
  if (!currentAngles) return false;
  const deltas = resolveViewport3DOrbitDebugControlDeltas({
    currentAngles,
    targetAngles,
  });
  controls.rotateLeft(deltas.rotateLeft);
  controls.rotateUp(deltas.rotateUp);
  controls.update();
  return true;
}

export function commitOrbitCameraEnd({
  cameraPosition,
  cameraUp = VIEWPORT_3D_WORLD_UP,
  controlTarget,
  onCameraChange,
  orthographicScale,
  projection,
  syncStore = true,
}: {
  cameraPosition: [number, number, number];
  cameraUp?: [number, number, number];
  controlTarget: number[];
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  orthographicScale?: number | null;
  projection?: Viewport3DCameraProjection;
  syncStore?: boolean;
}): void {
  if (controlTarget.length < 3) return;

  const nextCamera: Viewport3DCameraChange = {
    position: cameraPosition,
    target: tuple3(controlTarget),
    up: cameraUp,
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
  void Promise.resolve(onCameraChange(nextCamera)).catch(() => undefined);
}

export function applyViewport3DWorldUp(camera: Camera): void {
  camera.up.set(...VIEWPORT_3D_WORLD_UP);
}

function applyViewport3DCameraUp(
  camera: Camera,
  up: [number, number, number] | undefined,
): void {
  camera.up.set(...(up ?? VIEWPORT_3D_WORLD_UP));
}

function applyCameraLookAt(camera: Camera, target: [number, number, number]): void {
  camera.lookAt(...target);
  (camera as Camera & { updateProjectionMatrix?: () => void })
    .updateProjectionMatrix?.();
  camera.updateMatrix();
  camera.updateMatrixWorld();
}

export function resolveViewport3DCameraFit(
  bounds: Viewport3DBounds | null,
): Viewport3DCameraFit {
  const activeBounds = bounds ?? FALLBACK_CAMERA_BOUNDS;
  const [x, y, z] = activeBounds.center;
  const radius = Math.max(activeBounds.radius, 1e-12);
  const distance = radius * 2.8;
  const near = Math.max(distance / 100, 1e-12);
  const far = Math.max(distance * 100, near * 100, 1e-3);

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

function boundsSignature(bounds: Viewport3DBounds | null): string | null {
  if (!bounds) return null;
  return [
    ...bounds.center,
    ...bounds.size,
  ].map((value) => value.toExponential(6)).join(":");
}

function applyCameraClipping(camera: Camera, near: number, far: number) {
  const clippedCamera = camera as Camera & { near: number; far: number };
  clippedCamera.near = near;
  clippedCamera.far = far;
}

function nearCameraState(
  left: Viewport3DCameraState,
  right: Viewport3DCameraState,
): boolean {
  return (
    nearTuple3(left.position, right.position, CAMERA_STATE_EPSILON) &&
    nearTuple3(left.target, right.target, CAMERA_STATE_EPSILON) &&
    nearTuple3(
      left.up ?? VIEWPORT_3D_WORLD_UP,
      right.up ?? VIEWPORT_3D_WORLD_UP,
      CAMERA_STATE_EPSILON,
    )
  );
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

function isDefaultCameraState(cameraState: Viewport3DCameraState): boolean {
  return (
    sameTuple3(cameraState.position, DEFAULT_VIEWPORT_3D_CAMERA_STATE.position) &&
    sameTuple3(cameraState.target, DEFAULT_VIEWPORT_3D_CAMERA_STATE.target)
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

export function CameraController({
  bounds,
  cameraState,
  fitRevision,
  interactionActive,
  onCameraChange,
  resetCameraRevision,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
  cameraState: Viewport3DCameraState;
  fitRevision: number;
  interactionActive: boolean;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  resetCameraRevision: number;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, invalidate } = useThree();
  const handledFitRevisionRef = useRef(fitRevision);
  const handledResetCameraRevisionRef = useRef(resetCameraRevision);
  const autoFittedBoundsRef = useRef<string | null>(null);
  const lastAutoFitCameraStateRef = useRef<Viewport3DCameraState | null>(null);
  const appliedCameraRef = useRef<Camera | null>(null);
  const appliedCameraStateRef = useRef<Viewport3DCameraState | null>(null);
  const onCameraChangeRef = useRef(onCameraChange);
  const cameraStateRef = useRef(cameraState);

  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  useEffect(() => {
    cameraStateRef.current = cameraState;
  }, [cameraState]);

  useEffect(() => {
    const nextBoundsSignature = boundsSignature(bounds);
    const shouldAutoFitInitialBounds =
      nextBoundsSignature !== null &&
      autoFittedBoundsRef.current === null &&
      isDefaultCameraState(cameraStateRef.current);
    const shouldAutoFitChangedBounds = shouldAutoFitViewport3DBoundsChange({
      currentCameraState: cameraStateRef.current,
      lastAutoFitCameraState: lastAutoFitCameraStateRef.current,
      nextBoundsSignature,
      previousBoundsSignature: autoFittedBoundsRef.current,
    });
    const shouldFit =
      handledFitRevisionRef.current !== fitRevision ||
      handledResetCameraRevisionRef.current !== resetCameraRevision ||
      shouldAutoFitInitialBounds ||
      shouldAutoFitChangedBounds;
    if (!shouldFit) return;

    const fit = resolveViewport3DCameraFit(bounds);

    applyViewport3DWorldUp(camera);
    camera.position.set(...fit.position);
    applyCameraLookAt(camera, fit.target);
    applyCameraClipping(camera, fit.near, fit.far);
    camera.updateProjectionMatrix();
    handledFitRevisionRef.current = fitRevision;
    handledResetCameraRevisionRef.current = resetCameraRevision;
    autoFittedBoundsRef.current = nextBoundsSignature;
    const nextCamera = {
      position: fit.position,
      target: fit.target,
      up: VIEWPORT_3D_WORLD_UP,
    };
    lastAutoFitCameraStateRef.current = nextCamera;
    appliedCameraRef.current = camera;
    appliedCameraStateRef.current = nextCamera;
    viewport3dStore.setCamera(nextCamera);
    void Promise.resolve(
      onCameraChangeRef.current(nextCamera),
    ).catch(() => undefined);
    invalidate();
    tracker.recordDirtyFrame("camera-fit");
  }, [
    bounds,
    camera,
    fitRevision,
    invalidate,
    resetCameraRevision,
    tracker,
  ]);

  useEffect(() => {
    const state = cameraStateRef.current;
    applyViewport3DCameraUp(camera, state.up);
    camera.position.set(...state.position);
    applyCameraLookAt(camera, state.target);
    camera.updateProjectionMatrix();
    appliedCameraRef.current = camera;
    appliedCameraStateRef.current = state;
    invalidate();
    tracker.recordDirtyFrame("camera-init");
    // Intentionally runs only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (interactionActive) return;
    if (
      !shouldApplyViewport3DCameraState({
        appliedCamera: appliedCameraRef.current,
        appliedCameraState: appliedCameraStateRef.current,
        currentCamera: camera,
        nextCameraState: cameraState,
      })
    ) {
      return;
    }
    applyViewport3DCameraUp(camera, cameraState.up);
    camera.position.set(...cameraState.position);
    applyCameraLookAt(camera, cameraState.target);
    camera.updateProjectionMatrix();
    appliedCameraRef.current = camera;
    appliedCameraStateRef.current = cameraState;
    invalidate();
    tracker.recordDirtyFrame("camera-resource");
  }, [camera, cameraState, interactionActive, invalidate, tracker]);

  return null;
}

function resolveViewport3DCurrentOrthographicScale({
  camera,
  fallbackScale,
  viewportHeightPixels,
}: {
  camera: Camera;
  fallbackScale: number | null;
  viewportHeightPixels: number;
}): number | null {
  const orthographicCamera = camera as Camera & {
    isOrthographicCamera?: boolean;
    zoom?: number;
  };
  if (
    orthographicCamera.isOrthographicCamera &&
    typeof orthographicCamera.zoom === "number" &&
    Number.isFinite(orthographicCamera.zoom) &&
    orthographicCamera.zoom > 0 &&
    viewportHeightPixels > 0
  ) {
    return viewportHeightPixels / orthographicCamera.zoom;
  }

  return fallbackScale;
}

export function OrbitCameraControls({
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  interactionActive,
  orbitDebugAngles,
  orbitDebugCommitRevision,
  orbitDebugRevision,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onOrbitDebugAnglesChange,
  tracker,
}: {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  interactionActive: boolean;
  orbitDebugAngles: Viewport3DOrbitDebugAngles;
  orbitDebugCommitRevision: number;
  orbitDebugRevision: number;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  onOrbitDebugAnglesChange?: (angles: Viewport3DOrbitDebugAngles) => void;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, invalidate, size } = useThree();
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const handledOrbitDebugRevisionRef = useRef(orbitDebugRevision);
  const handledOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const pendingOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const orbitDebugAnimatingRef = useRef(false);
  const orbitDebugTargetRef = useRef(
    normalizeViewport3DOrbitDebugAngles(orbitDebugAngles),
  );

  useEffect(() => {
    if (interactionActive) return;
    const controls = controlsRef.current;
    if (!controls) return;
    if (!shouldSyncOrbitControlsTarget(controls.target.toArray(), cameraState.target)) {
      return;
    }
    const [x, y, z] = cameraState.target;
    controls.target.set(x, y, z);
    controls.update();
    invalidate();
    tracker.recordDirtyFrame("camera-control-target");
  }, [cameraState.target, interactionActive, invalidate, tracker]);

  useEffect(() => {
    const controls = controlsRef.current;
    const currentAngles = readViewport3DOrbitDebugAngles(controls);
    if (currentAngles) {
      onOrbitDebugAnglesChange?.(currentAngles);
    }
  }, [onOrbitDebugAnglesChange]);

  useEffect(() => {
    if (handledOrbitDebugRevisionRef.current === orbitDebugRevision) return;
    handledOrbitDebugRevisionRef.current = orbitDebugRevision;
    orbitDebugTargetRef.current = normalizeViewport3DOrbitDebugAngles(orbitDebugAngles);
    orbitDebugAnimatingRef.current = true;
    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug-request");
  }, [
    invalidate,
    orbitDebugAngles,
    orbitDebugRevision,
    tracker,
  ]);

  useEffect(() => {
    if (pendingOrbitDebugCommitRevisionRef.current === orbitDebugCommitRevision) {
      return;
    }
    pendingOrbitDebugCommitRevisionRef.current = orbitDebugCommitRevision;
    orbitDebugAnimatingRef.current = true;
    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug-commit");
  }, [invalidate, orbitDebugCommitRevision, tracker]);

  useFrame((_, deltaSeconds) => {
    if (!orbitDebugAnimatingRef.current) return;

    const controls = controlsRef.current;
    if (!controls) return;

    const targetAngles = orbitDebugTargetRef.current;
    const currentAngles =
      readViewport3DOrbitDebugAngles(controls) ?? targetAngles;
    const nextAngles = resolveViewport3DOrbitDebugStep({
      currentAngles,
      deltaSeconds,
      targetAngles,
    });

    if (
      !applyViewport3DOrbitDebugControlAngles({
        controls,
        targetAngles: nextAngles,
      })
    ) {
      return;
    }

    const settled = !shouldApplyViewport3DOrbitDebugAngles(
      nextAngles,
      targetAngles,
    );
    orbitDebugAnimatingRef.current = !settled;
    if (
      settled &&
      handledOrbitDebugCommitRevisionRef.current !==
        pendingOrbitDebugCommitRevisionRef.current
    ) {
      handledOrbitDebugCommitRevisionRef.current =
        pendingOrbitDebugCommitRevisionRef.current;
      commitOrbitCameraEnd({
        cameraPosition: tuple3(camera.position.toArray()),
        cameraUp: tuple3(camera.up.toArray()),
        controlTarget: controls.target.toArray(),
        onCameraChange,
        orthographicScale:
          cameraProjection === "orthographic"
            ? resolveViewport3DCurrentOrthographicScale({
                camera,
                fallbackScale: cameraOrthographicScale,
                viewportHeightPixels: size.height,
              })
            : undefined,
        projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
      });
      onCameraInteractionEnd?.();
    }

    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug");
  });

  const recordOrbitControlFrame = useCallback(() => {
    invalidate();
    tracker.recordDirtyFrame("camera-control");
  }, [invalidate, tracker]);

  // Performance Optimization: Debounce handleEnd for zoom/wheel interactions.
  // OrbitControls dispatches start and end events back-to-back synchronously
  // on every scroll/wheel event notch, which chokes the React/Zustand updates.
  // Debouncing end-of-interaction by 200ms groups rapid ticks into one active session.
  const endTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (endTimeoutRef.current !== null) {
        clearTimeout(endTimeoutRef.current);
      }
    };
  }, []);

  const handleStart = useCallback(() => {
    if (endTimeoutRef.current !== null) {
      clearTimeout(endTimeoutRef.current);
      endTimeoutRef.current = null;
    }
    onCameraInteractionStart?.();
  }, [onCameraInteractionStart]);

  const handleEnd = useCallback(() => {
    const target = controlsRef.current?.target.toArray() ?? cameraState.target;
    const orthographicScale =
      cameraProjection === "orthographic"
        ? resolveViewport3DCurrentOrthographicScale({
            camera,
            fallbackScale: cameraOrthographicScale,
            viewportHeightPixels: size.height,
          })
        : undefined;
    commitOrbitCameraEnd({
      cameraPosition: tuple3(camera.position.toArray()),
      cameraUp: tuple3(camera.up.toArray()),
      controlTarget: target,
      onCameraChange,
      orthographicScale,
      projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
    });
    const currentAngles = readViewport3DOrbitDebugAngles(controlsRef.current);
    if (currentAngles) {
      onOrbitDebugAnglesChange?.(currentAngles);
    }
    onCameraInteractionEnd?.();
  }, [
    camera,
    cameraOrthographicScale,
    cameraProjection,
    cameraState.target,
    onCameraChange,
    onCameraInteractionEnd,
    onOrbitDebugAnglesChange,
    size.height,
  ]);

  const handleEndRef = useRef(handleEnd);
  useEffect(() => {
    handleEndRef.current = handleEnd;
  }, [handleEnd]);

  const debouncedHandleEnd = useCallback(() => {
    if (endTimeoutRef.current !== null) {
      clearTimeout(endTimeoutRef.current);
    }
    endTimeoutRef.current = setTimeout(() => {
      endTimeoutRef.current = null;
      handleEndRef.current();
    }, 200);
  }, []);

  const options = resolveViewport3DCameraInteractionOptions();

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping={options.enableDamping}
      enablePan={options.enablePan}
      enableZoom={options.enableZoom}
      mouseButtons={options.mouseButtons}
      panSpeed={options.panSpeed}
      rotateSpeed={options.rotateSpeed}
      screenSpacePanning={options.screenSpacePanning}
      zoomToCursor
      onChange={recordOrbitControlFrame}
      onEnd={debouncedHandleEnd}
      onStart={handleStart}
    />
  );
}

function tuple3(values: readonly number[]): [number, number, number] {
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

function normalizeOrbitDebugAzimuthFromControls(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = value % ORBIT_DEBUG_TWO_PI;
  return wrapped < 0 ? wrapped + ORBIT_DEBUG_TWO_PI : wrapped;
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
