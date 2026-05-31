"use client";

import { ArcballControls as DreiArcballControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef } from "react";
import { MathUtils, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { nearTuple3, sameTuple3 } from "../viewport3dMath";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
} from "../viewport3dStore";
import {
  beginViewport3DCameraGesture,
  endViewport3DCameraGesture,
  viewport3DCameraGestureActive,
  type Viewport3DCameraGestureRef,
} from "./viewport3DCameraGesture";

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

type ArcballControlsHandle = ComponentRef<typeof DreiArcballControls>;

interface Viewport3DCameraInteractionOptions {
  dampingFactor: number;
  enableAnimations: boolean;
  enablePan: boolean;
  enableRotate: boolean;
  enableZoom: boolean;
  scaleFactor: number;
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
const VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS = 180;
export const VIEWPORT_3D_ORBIT_DEBUG_LIMITS = {
  azimuthMax: ORBIT_DEBUG_TWO_PI,
  azimuthMin: 0,
  polarMax: Math.PI,
  polarMin: 0,
} as const;

const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  dampingFactor: 25,
  enableAnimations: true,
  enablePan: true,
  enableRotate: true,
  enableZoom: true,
  scaleFactor: 1.08,
} satisfies Viewport3DCameraInteractionOptions;

export function resolveViewport3DCameraInteractionOptions(): Viewport3DCameraInteractionOptions {
  return VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS;
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

function readViewport3DOrbitDebugAngles(
  controls: ArcballControlsHandle | null,
  camera: Camera,
): Viewport3DOrbitDebugAngles | null {
  const target = controls?.target;
  if (!target) return null;
  const offset = camera.position.clone().sub(target);
  const radius = offset.length();
  if (!Number.isFinite(radius) || radius <= 0) return null;
  return normalizeViewport3DOrbitDebugAngles({
    azimuth: normalizeOrbitDebugAzimuthFromControls(
      Math.atan2(offset.y, offset.x),
    ),
    polar: Math.acos(MathUtils.clamp(offset.z / radius, -1, 1)),
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
}): { azimuth: number; polar: number } {
  return {
    azimuth: shortestOrbitDebugAzimuthDelta(
      currentAngles.azimuth,
      targetAngles.azimuth,
    ),
    polar: targetAngles.polar - currentAngles.polar,
  };
}

function applyViewport3DOrbitDebugCameraAngles({
  camera,
  controls,
  targetAngles,
}: {
  camera: Camera;
  controls: ArcballControlsHandle;
  targetAngles: Viewport3DOrbitDebugAngles;
}): boolean {
  const target = controls.target;
  if (!target) return false;
  const currentAngles = readViewport3DOrbitDebugAngles(controls, camera);
  if (!currentAngles) return false;
  const radius = camera.position.distanceTo(target);
  if (!Number.isFinite(radius) || radius <= 0) return false;
  const deltas = resolveViewport3DOrbitDebugControlDeltas({
    currentAngles,
    targetAngles,
  });
  const nextAzimuth = currentAngles.azimuth + deltas.azimuth;
  const nextPolar = currentAngles.polar + deltas.polar;
  const sinPolar = Math.sin(nextPolar);
  camera.position.set(
    target.x + radius * sinPolar * Math.cos(nextAzimuth),
    target.y + radius * sinPolar * Math.sin(nextAzimuth),
    target.z + radius * Math.cos(nextPolar),
  );
  applyCameraLookAt(camera, tuple3(target.toArray()));
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
  cameraGestureRef,
  cameraState,
  fitRevision,
  onCameraChange,
  resetCameraRevision,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
  cameraGestureRef: Viewport3DCameraGestureRef;
  cameraState: Viewport3DCameraState;
  fitRevision: number;
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
    if (viewport3DCameraGestureActive(cameraGestureRef)) return;
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
  }, [camera, cameraGestureRef, cameraState, invalidate, tracker]);

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

interface OrbitCameraControlsProps {
  cameraGestureRef: Viewport3DCameraGestureRef;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  orbitDebugAngles: Viewport3DOrbitDebugAngles;
  orbitDebugCommitRevision: number;
  orbitDebugRevision: number;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onOrbitDebugAnglesChange?: (angles: Viewport3DOrbitDebugAngles) => void;
  tracker: Viewport3DResourceTracker;
}

function useOrbitCameraControlsModel({
  cameraGestureRef,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  orbitDebugAngles,
  orbitDebugCommitRevision,
  orbitDebugRevision,
  onCameraChange,
  onOrbitDebugAnglesChange,
  tracker,
}: OrbitCameraControlsProps) {
  const { camera, invalidate, size } = useThree();
  const controlsRef = useRef<ArcballControlsHandle>(null);
  const options = resolveViewport3DCameraInteractionOptions();
  const handledOrbitDebugRevisionRef = useRef(orbitDebugRevision);
  const handledOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const pendingOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const orbitDebugAnimatingRef = useRef(false);
  const orbitDebugTargetRef = useRef(
    normalizeViewport3DOrbitDebugAngles(orbitDebugAngles),
  );
  const controlsSyncingRef = useRef(false);
  const suppressNextRestCommitRef = useRef(false);
  const cameraControlsPoseCommitTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    if (viewport3DCameraGestureActive(cameraGestureRef)) return;
    const controls = controlsRef.current;
    const currentTarget = controls?.target?.toArray();
    if (!controls || !currentTarget) return;
    const currentPosition = camera.position.toArray();
    if (
      !shouldSyncCameraControlsPose({
        currentPosition,
        currentTarget,
        nextCameraState: cameraState,
      })
    ) {
      return;
    }
    controlsSyncingRef.current = true;
    try {
      applyViewport3DCameraUp(camera, cameraState.up);
      camera.position.set(...cameraState.position);
      applyCameraLookAt(camera, cameraState.target);
      controls.target.set(...cameraState.target);
      controls.update();
    } finally {
      controlsSyncingRef.current = false;
    }
    invalidate();
    tracker.recordDirtyFrame("camera-control-target");
  }, [camera, cameraGestureRef, cameraState, invalidate, tracker]);

  useEffect(() => {
    const controls = controlsRef.current;
    const currentAngles = controls
      ? readViewport3DOrbitDebugAngles(controls, camera)
      : null;
    if (currentAngles) {
      onOrbitDebugAnglesChange?.(currentAngles);
    }
  }, [camera, onOrbitDebugAnglesChange]);

  useEffect(() => {
    if (handledOrbitDebugRevisionRef.current === orbitDebugRevision) return;
    handledOrbitDebugRevisionRef.current = orbitDebugRevision;
    orbitDebugTargetRef.current = normalizeViewport3DOrbitDebugAngles(orbitDebugAngles);
    orbitDebugAnimatingRef.current = true;
    suppressNextRestCommitRef.current = true;
    beginViewport3DCameraGesture(cameraGestureRef);
    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug-request");
  }, [
    cameraGestureRef,
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
    suppressNextRestCommitRef.current = true;
    beginViewport3DCameraGesture(cameraGestureRef);
    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug-commit");
  }, [cameraGestureRef, invalidate, orbitDebugCommitRevision, tracker]);

  useFrame((_, deltaSeconds) => {
    if (!orbitDebugAnimatingRef.current) return;

    const controls = controlsRef.current;
    if (!controls) return;

    const targetAngles = orbitDebugTargetRef.current;
    const currentAngles =
      readViewport3DOrbitDebugAngles(controls, camera) ?? targetAngles;
    const nextAngles = resolveViewport3DOrbitDebugStep({
      currentAngles,
      deltaSeconds,
      targetAngles,
    });

    if (
      !applyViewport3DOrbitDebugCameraAngles({
        camera,
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
      const controlPosition = camera.position.toArray();
      const controlTarget = controls.target.toArray();
      commitOrbitCameraEnd({
        cameraPosition: tuple3(controlPosition),
        cameraUp: tuple3(camera.up.toArray()),
        controlTarget,
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
        syncStore: false,
      });
      endViewport3DCameraGesture(cameraGestureRef);
    } else if (settled) {
      endViewport3DCameraGesture(cameraGestureRef);
    }

    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug");
  });

  const commitCameraControlsPose = useCallback(() => {
    if (controlsSyncingRef.current) return;
    if (suppressNextRestCommitRef.current) {
      suppressNextRestCommitRef.current = false;
      return;
    }
    const controls = controlsRef.current;
    const controlTarget = controls?.target?.toArray();
    if (!controls || !controlTarget) {
      endViewport3DCameraGesture(cameraGestureRef);
      return;
    }
    const controlPosition = camera.position.toArray();
    const orthographicScale =
      cameraProjection === "orthographic"
        ? resolveViewport3DCurrentOrthographicScale({
            camera,
            fallbackScale: cameraOrthographicScale,
            viewportHeightPixels: size.height,
          })
        : undefined;
    commitOrbitCameraEnd({
      cameraPosition: tuple3(controlPosition),
      cameraUp: tuple3(camera.up.toArray()),
      controlTarget,
      onCameraChange,
      orthographicScale,
      projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
      syncStore: false,
    });
    const currentAngles = readViewport3DOrbitDebugAngles(controls, camera);
    if (currentAngles) {
      onOrbitDebugAnglesChange?.(currentAngles);
    }
    endViewport3DCameraGesture(cameraGestureRef);
  }, [
    camera,
    cameraGestureRef,
    cameraOrthographicScale,
    cameraProjection,
    onCameraChange,
    onOrbitDebugAnglesChange,
    size.height,
  ]);

  const clearCameraControlsPoseCommit = useCallback(() => {
    if (cameraControlsPoseCommitTimeoutRef.current === null) return;
    clearTimeout(cameraControlsPoseCommitTimeoutRef.current);
    cameraControlsPoseCommitTimeoutRef.current = null;
  }, []);

  const scheduleCameraControlsPoseCommit = useCallback(() => {
    if (
      controlsSyncingRef.current ||
      orbitDebugAnimatingRef.current ||
      suppressNextRestCommitRef.current
    ) {
      return;
    }
    clearCameraControlsPoseCommit();
    cameraControlsPoseCommitTimeoutRef.current = setTimeout(() => {
      cameraControlsPoseCommitTimeoutRef.current = null;
      commitCameraControlsPose();
    }, VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS);
  }, [clearCameraControlsPoseCommit, commitCameraControlsPose]);

  useEffect(
    () => () => {
      clearCameraControlsPoseCommit();
    },
    [clearCameraControlsPoseCommit],
  );

  const recordOrbitControlFrame = useCallback(() => {
    tracker.recordDirtyFrame("camera-control");
    scheduleCameraControlsPoseCommit();
  }, [scheduleCameraControlsPoseCommit, tracker]);

  const handleTransitionStart = useCallback(() => {
    if (controlsSyncingRef.current) return;
    clearCameraControlsPoseCommit();
    beginViewport3DCameraGesture(cameraGestureRef);
  }, [cameraGestureRef, clearCameraControlsPoseCommit]);

  const handleEnd = useCallback(() => {
    scheduleCameraControlsPoseCommit();
  }, [scheduleCameraControlsPoseCommit]);

  return {
    controlsRef,
    handleEnd,
    handleTransitionStart,
    options,
    recordOrbitControlFrame,
  };
}

export function OrbitCameraControls(props: OrbitCameraControlsProps) {
  const {
    controlsRef,
    handleEnd,
    handleTransitionStart,
    options,
    recordOrbitControlFrame,
  } = useOrbitCameraControlsModel(props);

  return (
    <DreiArcballControls
      ref={controlsRef}
      makeDefault
      dampingFactor={options.dampingFactor}
      enableAnimations={options.enableAnimations}
      enablePan={options.enablePan}
      enableRotate={options.enableRotate}
      enableZoom={options.enableZoom}
      scaleFactor={options.scaleFactor}
      onChange={recordOrbitControlFrame}
      onEnd={handleEnd}
      onStart={handleTransitionStart}
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
