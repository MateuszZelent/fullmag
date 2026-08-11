"use client";

import { OrbitControls as DreiOrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef } from "react";
import { MathUtils, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { isViewport3DImmediatePointerDownRegion } from "../viewport3dEventManager";
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
  cancelViewport3DCameraGesture,
  endViewport3DCameraGesture,
  markViewport3DCameraGestureChanged,
  settleViewport3DCameraGesture,
  viewport3DCameraGestureActive,
  type Viewport3DCameraGestureRef,
} from "./viewport3DCameraGesture";
import {
  viewport3DCameraSnapshotsEqual,
  type Viewport3DLiveCameraSnapshot,
} from "./viewport3DCameraState";

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

type OrbitControlsHandle = ComponentRef<typeof DreiOrbitControls>;

interface Viewport3DCameraControlsDiagnostics {
  cameraPosition: [number, number, number];
  cameraUp: [number, number, number];
  controlTarget: [number, number, number] | null;
  controlsConnectedToCanvas: boolean;
  controlsEnabled: boolean | null;
  controlsObjectIsCamera: boolean;
  enablePan: boolean | null;
  enableRotate: boolean | null;
  enableZoom: boolean | null;
  maxAzimuthAngle: number | null;
  maxDistance: number | null;
  maxPolarAngle: number | null;
  minAzimuthAngle: number | null;
  minDistance: number | null;
  minPolarAngle: number | null;
  mouseButtons: Record<string, number> | null;
  panSpeed: number | null;
  state: number | null;
}

declare global {
  interface Window {
    __FULLMAG_READ_VIEWPORT_3D_CAMERA_CONTROLS__?:
      () => Viewport3DCameraControlsDiagnostics;
  }
}

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

const FALLBACK_CAMERA_BOUNDS: Viewport3DBounds = {
  center: [0, 0, 0],
  radius: 1e-6,
  size: [1e-6, 1e-6, 1e-6],
};
export const VIEWPORT_3D_WORLD_UP: [number, number, number] = [0, 0, 1];
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
  dampingFactor: 0.08,
  enableDamping: true,
  enablePan: true,
  enableRotate: true,
  enableZoom: true,
  panSpeed: 2,
  rotateSpeed: 1,
  zoomSpeed: 1,
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
  controls: OrbitControlsHandle | null,
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
  controls: OrbitControlsHandle;
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

function isDefaultCameraState(cameraState: Viewport3DCameraState): boolean {
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
  onCameraChange: (
    camera: Viewport3DCameraChange,
    epoch?: number,
  ) => Promise<void> | void;
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
    if (viewport3DCameraGestureActive(cameraGestureRef)) return;
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
    void Promise.resolve(
      onCameraChangeRef.current(nextCamera),
    ).catch(() => undefined);
    invalidate();
    tracker.recordDirtyFrame("camera-fit");
  }, [
    bounds,
    camera,
    cameraGestureRef,
    fitRevision,
    invalidate,
    resetCameraRevision,
    tracker,
  ]);

  useEffect(() => {
    const state = cameraStateRef.current;
    if (
      shouldPreserveViewport3DAutoFitAgainstDefaultCamera({
        appliedCameraState: appliedCameraStateRef.current,
        autoFittedBoundsSignature: autoFittedBoundsRef.current,
        cameraState: state,
        lastAutoFitCameraState: lastAutoFitCameraStateRef.current,
      })
    ) {
      return;
    }
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
    if (
      shouldPreserveViewport3DAutoFitAgainstDefaultCamera({
        appliedCameraState: appliedCameraStateRef.current,
        autoFittedBoundsSignature: autoFittedBoundsRef.current,
        cameraState,
        lastAutoFitCameraState: lastAutoFitCameraStateRef.current,
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

function readViewport3DCameraControlsDiagnostics({
  camera,
  controls,
  domElement,
}: {
  camera: Camera;
  controls: OrbitControlsHandle | null;
  domElement: HTMLElement;
}): Viewport3DCameraControlsDiagnostics {
  const controlsState = controls as
    | (OrbitControlsHandle & {
        domElement?: HTMLElement;
        enablePan?: boolean;
        enableRotate?: boolean;
        enableZoom?: boolean;
        maxAzimuthAngle?: number;
        maxDistance?: number;
        maxPolarAngle?: number;
        minAzimuthAngle?: number;
        minDistance?: number;
        minPolarAngle?: number;
        mouseButtons?: Record<string, number>;
        object?: Camera;
        panSpeed?: number;
        state?: number;
      })
    | null;
  return {
    cameraPosition: tuple3(camera.position.toArray()),
    cameraUp: tuple3(camera.up.toArray()),
    controlTarget: controls?.target ? tuple3(controls.target.toArray()) : null,
    controlsConnectedToCanvas: controlsState?.domElement === domElement,
    controlsEnabled:
      typeof controlsState?.enabled === "boolean" ? controlsState.enabled : null,
    controlsObjectIsCamera: controlsState?.object === camera,
    enablePan:
      typeof controlsState?.enablePan === "boolean"
        ? controlsState.enablePan
        : null,
    enableRotate:
      typeof controlsState?.enableRotate === "boolean"
        ? controlsState.enableRotate
        : null,
    enableZoom:
      typeof controlsState?.enableZoom === "boolean"
        ? controlsState.enableZoom
        : null,
    maxAzimuthAngle:
      typeof controlsState?.maxAzimuthAngle === "number"
        ? controlsState.maxAzimuthAngle
        : null,
    maxDistance:
      typeof controlsState?.maxDistance === "number"
        ? controlsState.maxDistance
        : null,
    maxPolarAngle:
      typeof controlsState?.maxPolarAngle === "number"
        ? controlsState.maxPolarAngle
        : null,
    minAzimuthAngle:
      typeof controlsState?.minAzimuthAngle === "number"
        ? controlsState.minAzimuthAngle
        : null,
    minDistance:
      typeof controlsState?.minDistance === "number"
        ? controlsState.minDistance
        : null,
    minPolarAngle:
      typeof controlsState?.minPolarAngle === "number"
        ? controlsState.minPolarAngle
        : null,
    mouseButtons: controlsState?.mouseButtons ?? null,
    panSpeed:
      typeof controlsState?.panSpeed === "number" ? controlsState.panSpeed : null,
    state: typeof controlsState?.state === "number" ? controlsState.state : null,
  };
}

interface OrbitCameraControlsProps {
  bounds: Viewport3DBounds | null;
  cameraGestureRef: Viewport3DCameraGestureRef;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  orbitDebugAngles: Viewport3DOrbitDebugAngles;
  orbitDebugCommitRevision: number;
  orbitDebugRevision: number;
  onCameraChange: (
    camera: Viewport3DCameraChange,
    epoch?: number,
  ) => Promise<void> | void;
  onCameraInteractionEnd?: (epoch?: number) => void;
  onCameraInteractionStart?: (epoch?: number) => void;
  onOrbitDebugAnglesChange?: (angles: Viewport3DOrbitDebugAngles) => void;
  tracker: Viewport3DResourceTracker;
}


function useOrbitCameraControlsModel({
  bounds,
  cameraGestureRef,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  orbitDebugAngles,
  orbitDebugCommitRevision,
  orbitDebugRevision,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onOrbitDebugAnglesChange,
  tracker,
}: OrbitCameraControlsProps) {
  const { camera, invalidate, size } = useThree();
  const gl = useThree((state) => state.gl);
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const options = resolveViewport3DCameraInteractionOptions();
  const handledOrbitDebugRevisionRef = useRef(orbitDebugRevision);
  const handledOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const pendingOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const orbitDebugAnimatingRef = useRef(false);
  const orbitDebugTargetRef = useRef(
    normalizeViewport3DOrbitDebugAngles(orbitDebugAngles),
  );
  const controlsSyncingRef = useRef(false);
  const cameraGestureEndedRef = useRef(false);
  const activeGestureEpochRef = useRef<number | null>(null);
  const previousHudControlsEnabledRef = useRef<boolean | null>(null);
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
    const fittedCamera = bounds ? resolveViewport3DCameraFit(bounds) : null;
    if (
      fittedCamera &&
      shouldPreserveViewport3DAutoFitAgainstDefaultCamera({
        appliedCameraState: {
          position: tuple3(currentPosition),
          target: tuple3(currentTarget),
          up: tuple3(camera.up.toArray()),
        },
        autoFittedBoundsSignature: "orbit-bounds",
        cameraState,
        lastAutoFitCameraState: {
          position: fittedCamera.position,
          target: fittedCamera.target,
          up: VIEWPORT_3D_WORLD_UP,
        },
      })
    ) {
      return;
    }
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
  }, [
    bounds,
    camera,
    cameraGestureRef,
    cameraState,
    invalidate,
    tracker,
  ]);


  useEffect(() => {
    const element = gl.domElement;
    const listenerController = new AbortController();

    const restoreControls = () => {
      const previousEnabled = previousHudControlsEnabledRef.current;
      previousHudControlsEnabledRef.current = null;
      const controls = controlsRef.current;
      if (!controls || previousEnabled === null) return;
      controls.enabled = previousEnabled;
    };

    const handlePointerDownCapture = (event: PointerEvent) => {
      if (!isViewport3DImmediatePointerDownRegion(event)) return;
      const controls = controlsRef.current;
      if (!controls || previousHudControlsEnabledRef.current !== null) return;
      previousHudControlsEnabledRef.current = Boolean(controls.enabled);
      controls.enabled = false;
    };

    window.addEventListener("pointerup", restoreControls, {
      capture: true,
      signal: listenerController.signal,
    });
    window.addEventListener("pointercancel", restoreControls, {
      capture: true,
      signal: listenerController.signal,
    });
    element.addEventListener("pointerdown", handlePointerDownCapture, {
      capture: true,
      signal: listenerController.signal,
    });
    return () => {
      listenerController.abort();
      restoreControls();
    };
  }, [gl]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") {
      return undefined;
    }
    const readDiagnostics = () =>
      readViewport3DCameraControlsDiagnostics({
        camera,
        controls: controlsRef.current,
        domElement: gl.domElement,
      });
    window.__FULLMAG_READ_VIEWPORT_3D_CAMERA_CONTROLS__ = readDiagnostics;
    return () => {
      if (
        window.__FULLMAG_READ_VIEWPORT_3D_CAMERA_CONTROLS__ === readDiagnostics
      ) {
        delete window.__FULLMAG_READ_VIEWPORT_3D_CAMERA_CONTROLS__;
      }
    };
  }, [camera, gl]);

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

  const commitCameraControlsPose = useCallback((epoch: number) => {
    if (activeGestureEpochRef.current !== epoch) return;
    if (controlsSyncingRef.current) return;
    if (suppressNextRestCommitRef.current) {
      suppressNextRestCommitRef.current = false;
      settleViewport3DCameraGesture(cameraGestureRef, epoch);
      onCameraInteractionEnd?.(epoch);
      activeGestureEpochRef.current = null;
      return;
    }
    const controls = controlsRef.current;
    const controlTarget = controls?.target?.toArray();
    if (!controls || !controlTarget) {
      if (cameraGestureEndedRef.current) {
        cancelViewport3DCameraGesture(cameraGestureRef, epoch);
        onCameraInteractionEnd?.(epoch);
        activeGestureEpochRef.current = null;
      }
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
      controlTarget,
      epoch,
      onCameraChange,
      orthographicScale,
      projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
      syncStore: false,
    });
    const currentAngles = readViewport3DOrbitDebugAngles(controls, camera);
    if (currentAngles) {
      onOrbitDebugAnglesChange?.(currentAngles);
    }
    if (cameraGestureEndedRef.current) {
      settleViewport3DCameraGesture(cameraGestureRef, epoch);
      onCameraInteractionEnd?.(epoch);
      activeGestureEpochRef.current = null;
    }
  }, [
    camera,
    cameraGestureRef,
    cameraOrthographicScale,
    cameraProjection,
    onCameraChange,
    onCameraInteractionEnd,
    onOrbitDebugAnglesChange,
    size.height,
  ]);

  const clearCameraControlsPoseCommit = useCallback(() => {
    if (cameraControlsPoseCommitTimeoutRef.current === null) return;
    clearTimeout(cameraControlsPoseCommitTimeoutRef.current);
    cameraControlsPoseCommitTimeoutRef.current = null;
  }, []);

  const scheduleCameraControlsPoseCommit = useCallback((epoch: number, {
    restart = false,
  }: { restart?: boolean } = {}) => {
    if (
      controlsSyncingRef.current ||
      orbitDebugAnimatingRef.current ||
      suppressNextRestCommitRef.current
    ) {
      return;
    }
    if (cameraControlsPoseCommitTimeoutRef.current !== null) {
      if (!restart) return;
      clearCameraControlsPoseCommit();
    }
    cameraControlsPoseCommitTimeoutRef.current = setTimeout(() => {
      cameraControlsPoseCommitTimeoutRef.current = null;
      commitCameraControlsPose(epoch);
    }, VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS);
  }, [clearCameraControlsPoseCommit, commitCameraControlsPose]);

  useEffect(
    () => () => {
      clearCameraControlsPoseCommit();
      const epoch = activeGestureEpochRef.current;
      if (epoch === null) return;
      cancelViewport3DCameraGesture(cameraGestureRef, epoch);
      onCameraInteractionEnd?.(epoch);
      activeGestureEpochRef.current = null;
    },
    [
      cameraGestureRef,
      clearCameraControlsPoseCommit,
      onCameraInteractionEnd,
    ],
  );

  const recordOrbitControlFrame = useCallback(() => {
    tracker.recordDirtyFrame("camera-control");
    // OrbitControls emits change events continuously while the pointer is
    // held. Do not publish intermediate poses into React/store state: that
    // invalidates the viewport every 180 ms and can feed a stale pose back
    // into the live controls. Commit only after onEnd, then let damping
    // changes restart the quiet-period timer until the pose settles.
    const epoch = activeGestureEpochRef.current;
    if (epoch === null) return;
    markViewport3DCameraGestureChanged(cameraGestureRef, epoch);
    if (cameraGestureEndedRef.current) {
      scheduleCameraControlsPoseCommit(epoch, { restart: true });
    }
  }, [cameraGestureRef, scheduleCameraControlsPoseCommit, tracker]);

  const handleTransitionStart = useCallback(() => {
    if (controlsSyncingRef.current) return;
    clearCameraControlsPoseCommit();
    const previousEpoch = activeGestureEpochRef.current;
    if (previousEpoch !== null) {
      cancelViewport3DCameraGesture(cameraGestureRef, previousEpoch);
      onCameraInteractionEnd?.(previousEpoch);
    }
    cameraGestureEndedRef.current = false;
    const epoch = beginViewport3DCameraGesture(cameraGestureRef, "orbit");
    if (epoch < 0) return;
    activeGestureEpochRef.current = epoch;
    onCameraInteractionStart?.(epoch);
  }, [
    cameraGestureRef,
    clearCameraControlsPoseCommit,
    onCameraInteractionEnd,
    onCameraInteractionStart,
  ]);

  const handleEnd = useCallback(() => {
    const epoch = activeGestureEpochRef.current;
    if (epoch === null) return;
    cameraGestureEndedRef.current = true;
    scheduleCameraControlsPoseCommit(epoch, { restart: true });
  }, [scheduleCameraControlsPoseCommit]);

  return {
    controlsRef,
    domElement: gl.domElement,
    handleEnd,
    handleTransitionStart,
    options,
    recordOrbitControlFrame,
  };
}

export function OrbitCameraControls(props: OrbitCameraControlsProps) {
  const {
    controlsRef,
    domElement,
    handleEnd,
    handleTransitionStart,
    options,
    recordOrbitControlFrame,
  } = useOrbitCameraControlsModel(props);

  return (
    <DreiOrbitControls
      ref={controlsRef}
      makeDefault
      domElement={domElement}
      dampingFactor={options.dampingFactor}
      enableDamping={options.enableDamping}
      enablePan={options.enablePan}
      enableRotate={options.enableRotate}
      enableZoom={options.enableZoom}
      panSpeed={options.panSpeed}
      rotateSpeed={options.rotateSpeed}
      screenSpacePanning
      zoomSpeed={options.zoomSpeed}
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
