"use client";

import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { MOUSE, Vector3, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { clampNumber, nearTuple3, sameTuple3 } from "../viewport3dMath";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
  type Viewport3DRotationMode,
} from "../viewport3dStore";

interface Viewport3DNativeCameraPanEvent {
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface Viewport3DNativeCameraOrbitEvent {
  button: number;
}

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

type OrbitMouseAction = (typeof MOUSE)[keyof typeof MOUSE];

interface Viewport3DCameraInteractionOptions {
  enableDamping: false;
  enablePan: true;
  enableZoom: false;
  mouseButtons: {
    LEFT: OrbitMouseAction;
    MIDDLE: OrbitMouseAction;
    RIGHT: OrbitMouseAction;
  };
  panSpeed: number;
  rotateSpeed: number;
  screenSpacePanning: true;
}

type NativeGestureState = {
  hasDragged: boolean;
  lastX: number;
  lastY: number;
  mode: "orbit" | "pan";
  pointerId: number;
  startX: number;
  startY: number;
};

const FALLBACK_CAMERA_BOUNDS: Viewport3DBounds = {
  center: [0, 0, 0],
  radius: 1e-6,
  size: [1e-6, 1e-6, 1e-6],
};
export const VIEWPORT_3D_WORLD_UP: [number, number, number] = [0, 0, 1];
const WHEEL_CAMERA_COMMIT_DELAY_MS = 180;
const WHEEL_ZOOM_INTENSITY = 0.0024;
const WHEEL_ZOOM_MIN_DISTANCE = 1e-12;
const WHEEL_ZOOM_MAX_DISTANCE = 1e-2;
const CAMERA_STATE_EPSILON = 1e-7;
const VIEWPORT_3D_ORBIT_PAN_SPEED = 2.75;
const VIEWPORT_3D_ORBIT_ROTATE_SPEED = 1;
const VIEWPORT_3D_NATIVE_ORBIT_BUTTON = 0;
const VIEWPORT_3D_NATIVE_PAN_BUTTON = 2;
const VIEWPORT_3D_DRAG_THRESHOLD_PX = 4;
const VIEWPORT_3D_LOCAL_CAMERA_SYNC_THROTTLE_MS = 67;
const VIEWPORT_3D_MIN_POLAR_ANGLE = 0.05;
const VIEWPORT_3D_MAX_POLAR_ANGLE = Math.PI - 0.05;

const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  enableDamping: false,
  enablePan: true,
  enableZoom: false,
  mouseButtons: {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.PAN,
    RIGHT: MOUSE.PAN,
  },
  panSpeed: VIEWPORT_3D_ORBIT_PAN_SPEED,
  rotateSpeed: VIEWPORT_3D_ORBIT_ROTATE_SPEED,
  screenSpacePanning: true,
} satisfies Viewport3DCameraInteractionOptions;

export function resolveViewport3DCameraInteractionOptions(): Viewport3DCameraInteractionOptions {
  return VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS;
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

  const nextCamera = {
    position: cameraPosition,
    target: [
      controlTarget[0] ?? 0,
      controlTarget[1] ?? 0,
      controlTarget[2] ?? 0,
    ] as [number, number, number],
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

export function shouldHandleViewport3DNativeCameraPan(
  event: Viewport3DNativeCameraPanEvent,
): boolean {
  return event.button === VIEWPORT_3D_NATIVE_PAN_BUTTON;
}

export function shouldHandleViewport3DNativeCameraOrbit(
  event: Viewport3DNativeCameraOrbitEvent,
): boolean {
  return event.button === VIEWPORT_3D_NATIVE_ORBIT_BUTTON;
}

export function resolveViewport3DPerspectivePanDistance({
  cameraDistance,
  deltaPixels,
  fovDegrees,
  viewportHeightPixels,
}: {
  cameraDistance: number;
  deltaPixels: number;
  fovDegrees: number;
  viewportHeightPixels: number;
}): number {
  if (
    !Number.isFinite(cameraDistance) ||
    !Number.isFinite(deltaPixels) ||
    !Number.isFinite(fovDegrees) ||
    !Number.isFinite(viewportHeightPixels) ||
    cameraDistance <= 0 ||
    viewportHeightPixels <= 0
  ) {
    return 0;
  }

  const targetDistance =
    cameraDistance * Math.tan((fovDegrees / 2) * Math.PI / 180);
  return (
    2 *
    Math.abs(deltaPixels) *
    targetDistance *
    VIEWPORT_3D_ORBIT_PAN_SPEED /
    viewportHeightPixels
  );
}

export function applyViewport3DNativeCameraPan({
  camera,
  deltaX,
  deltaY,
  target,
  viewportHeightPixels,
  viewportWidthPixels,
}: {
  camera: Camera;
  deltaX: number;
  deltaY: number;
  target: Vector3;
  viewportHeightPixels: number;
  viewportWidthPixels: number;
}): boolean {
  if (
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY) ||
    viewportHeightPixels <= 0 ||
    viewportWidthPixels <= 0
  ) {
    return false;
  }

  camera.updateMatrixWorld();
  const panOffset = resolveViewport3DNativeCameraPanOffset({
    camera,
    deltaX: deltaX * VIEWPORT_3D_ORBIT_PAN_SPEED,
    deltaY: deltaY * VIEWPORT_3D_ORBIT_PAN_SPEED,
    target,
    viewportHeightPixels,
    viewportWidthPixels,
  });
  if (!panOffset) return false;

  camera.position.add(panOffset);
  target.add(panOffset);
  applyCameraLookAt(camera, target);
  return true;
}

export function applyViewport3DNativeCameraOrbit({
  camera,
  deltaX,
  deltaY,
  rotationMode = "camera",
  target,
  viewportHeightPixels,
}: {
  camera: Camera;
  deltaX: number;
  deltaY: number;
  rotationMode?: Viewport3DRotationMode;
  target: Vector3;
  viewportHeightPixels: number;
}): boolean {
  if (
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY) ||
    !Number.isFinite(viewportHeightPixels) ||
    viewportHeightPixels <= 0
  ) {
    return false;
  }

  const yawDelta =
    -2 * Math.PI * deltaX * VIEWPORT_3D_ORBIT_ROTATE_SPEED / viewportHeightPixels;
  const polarDelta =
    2 * Math.PI * deltaY * VIEWPORT_3D_ORBIT_ROTATE_SPEED / viewportHeightPixels;

  if (rotationMode === "object") {
    const offset = camera.position.clone().sub(target);
    const nextOffset = rotateZUpSphericalVector(offset, yawDelta, polarDelta);
    if (!nextOffset) return false;

    camera.position.copy(target).add(nextOffset);
    applyCameraLookAt(camera, target);
    return true;
  }

  const forward = target.clone().sub(camera.position);
  const focusDistance = forward.length();
  const nextForward = rotateZUpSphericalVector(forward, yawDelta, polarDelta);
  if (!nextForward || focusDistance <= 0) return false;

  target.copy(camera.position).add(nextForward);
  applyCameraLookAt(camera, target);
  return true;
}

function rotateZUpSphericalVector(
  vector: Vector3,
  yawDelta: number,
  polarDelta: number,
): Vector3 | null {
  const radius = vector.length();
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const azimuth = Math.atan2(vector.y, vector.x) + yawDelta;
  const polar = clampNumber(
    Math.acos(clampNumber(vector.z / radius, -1, 1)) + polarDelta,
    VIEWPORT_3D_MIN_POLAR_ANGLE,
    VIEWPORT_3D_MAX_POLAR_ANGLE,
  );
  const sinPolar = Math.sin(polar);

  return new Vector3(
    radius * sinPolar * Math.cos(azimuth),
    radius * sinPolar * Math.sin(azimuth),
    radius * Math.cos(polar),
  );
}

function resolveViewport3DNativeCameraPanOffset({
  camera,
  deltaX,
  deltaY,
  target,
  viewportHeightPixels,
  viewportWidthPixels,
}: {
  camera: Camera;
  deltaX: number;
  deltaY: number;
  target: Vector3;
  viewportHeightPixels: number;
  viewportWidthPixels: number;
}): Vector3 | null {
  const panOffset = new Vector3();
  const objectMatrix = camera.matrix;
  const cameraWithProjection = camera as Camera & {
    bottom?: number;
    fov?: number;
    isOrthographicCamera?: boolean;
    isPerspectiveCamera?: boolean;
    left?: number;
    right?: number;
    top?: number;
    zoom?: number;
  };

  if (cameraWithProjection.isPerspectiveCamera && cameraWithProjection.fov) {
    const cameraOffset = new Vector3().copy(camera.position).sub(target);
    const targetDistance =
      cameraOffset.length() *
      Math.tan((cameraWithProjection.fov / 2) * Math.PI / 180);
    addViewport3DPanLeft(
      panOffset,
      2 * deltaX * targetDistance / viewportHeightPixels,
      objectMatrix,
    );
    addViewport3DPanUp(
      panOffset,
      2 * deltaY * targetDistance / viewportHeightPixels,
      objectMatrix,
    );
    return panOffset;
  }

  if (
    cameraWithProjection.isOrthographicCamera &&
    typeof cameraWithProjection.left === "number" &&
    typeof cameraWithProjection.right === "number" &&
    typeof cameraWithProjection.top === "number" &&
    typeof cameraWithProjection.bottom === "number" &&
    typeof cameraWithProjection.zoom === "number" &&
    cameraWithProjection.zoom > 0
  ) {
    addViewport3DPanLeft(
      panOffset,
      deltaX *
        (cameraWithProjection.right - cameraWithProjection.left) /
        cameraWithProjection.zoom /
        viewportWidthPixels,
      objectMatrix,
    );
    addViewport3DPanUp(
      panOffset,
      deltaY *
        (cameraWithProjection.top - cameraWithProjection.bottom) /
        cameraWithProjection.zoom /
        viewportHeightPixels,
      objectMatrix,
    );
    return panOffset;
  }

  return null;
}

function addViewport3DPanLeft(
  panOffset: Vector3,
  distance: number,
  objectMatrix: Camera["matrix"],
): void {
  panOffset.add(
    new Vector3().setFromMatrixColumn(objectMatrix, 0).multiplyScalar(-distance),
  );
}

function addViewport3DPanUp(
  panOffset: Vector3,
  distance: number,
  objectMatrix: Camera["matrix"],
): void {
  panOffset.add(
    new Vector3().setFromMatrixColumn(objectMatrix, 1).multiplyScalar(distance),
  );
}

function resolveViewport3DElementSize(element: HTMLElement): {
  height: number;
  width: number;
} {
  const rect = element.getBoundingClientRect();
  const canvas = element as HTMLCanvasElement;
  return {
    height: element.clientHeight || rect.height || canvas.height || 0,
    width: element.clientWidth || rect.width || canvas.width || 0,
  };
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

function applyCameraLookAt(camera: Camera, target: Vector3): void {
  if (camera.up.lengthSq() <= 0) {
    applyViewport3DWorldUp(camera);
  }
  camera.lookAt(target);
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

export function resolveWheelZoomDistance(
  currentDistance: number,
  deltaY: number,
): number {
  if (!Number.isFinite(currentDistance) || currentDistance <= 0) {
    return WHEEL_ZOOM_MIN_DISTANCE;
  }
  const clampedDelta = Math.max(-1000, Math.min(1000, deltaY));
  const scale = Math.exp(clampedDelta * WHEEL_ZOOM_INTENSITY);
  return Math.max(
    WHEEL_ZOOM_MIN_DISTANCE,
    Math.min(WHEEL_ZOOM_MAX_DISTANCE, currentDistance * scale),
  );
}

export function resolveViewport3DOrthographicWheelScale(
  currentScale: number,
  deltaY: number,
): number {
  if (!Number.isFinite(currentScale) || currentScale <= 0) {
    return WHEEL_ZOOM_MIN_DISTANCE;
  }
  const clampedDelta = Math.max(-1000, Math.min(1000, deltaY));
  const scale = Math.exp(clampedDelta * WHEEL_ZOOM_INTENSITY);
  return clampNumber(currentScale * scale, WHEEL_ZOOM_MIN_DISTANCE, 1e12);
}

export function resolveViewport3DLocalCameraSyncDue({
  lastSyncedAtMs,
  nowMs,
}: {
  lastSyncedAtMs: number | null;
  nowMs: number;
}): boolean {
  return (
    lastSyncedAtMs === null ||
    nowMs - lastSyncedAtMs >= VIEWPORT_3D_LOCAL_CAMERA_SYNC_THROTTLE_MS
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
  onCameraChange,
  resetCameraRevision,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
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
    camera.lookAt(...fit.target);
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
    camera.lookAt(...state.target);
    camera.updateProjectionMatrix();
    appliedCameraRef.current = camera;
    appliedCameraStateRef.current = state;
    invalidate();
    tracker.recordDirtyFrame("camera-init");
    // Intentionally runs only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
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
    camera.lookAt(...cameraState.target);
    camera.updateProjectionMatrix();
    appliedCameraRef.current = camera;
    appliedCameraStateRef.current = cameraState;
    invalidate();
    tracker.recordDirtyFrame("camera-resource");
  }, [camera, cameraState, invalidate, tracker]);

  return null;
}

function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function commitCurrentCamera({
  camera,
  onCameraChange,
  orthographicScale,
  projection,
  syncStore,
  target,
}: {
  camera: Camera;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  orthographicScale?: number | null;
  projection?: Viewport3DCameraProjection;
  syncStore?: boolean;
  target: Vector3;
}): void {
  commitOrbitCameraEnd({
    cameraPosition: camera.position.toArray() as [number, number, number],
    cameraUp: camera.up.toArray() as [number, number, number],
    controlTarget: target.toArray(),
    onCameraChange,
    orthographicScale,
    projection,
    syncStore,
  });
}

function syncLocalCameraStore({
  camera,
  orthographicScale,
  projection,
  target,
}: {
  camera: Camera;
  orthographicScale?: number | null;
  projection?: Viewport3DCameraProjection;
  target: Vector3;
}): void {
  const nextCamera = {
    position: camera.position.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
    up: camera.up.toArray() as [number, number, number],
  };
  if (projection === undefined && orthographicScale === undefined) {
    viewport3dStore.setCamera(nextCamera);
    return;
  }

  viewport3dStore.setCameraView({
    camera: nextCamera,
    orthographicScale,
    projection: projection ?? viewport3dStore.getSnapshot().widgets.cameraProjection,
  });
}

function stopCameraEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function captureViewport3DPointer(element: HTMLElement, pointerId: number): void {
  if (!element.hasPointerCapture(pointerId)) {
    element.setPointerCapture(pointerId);
  }
}

function releaseViewport3DPointer(element: HTMLElement, pointerId: number): void {
  if (element.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
}

function gestureMovedPastThreshold(
  gesture: NativeGestureState,
  event: PointerEvent,
): boolean {
  return (
    Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >=
    VIEWPORT_3D_DRAG_THRESHOLD_PX
  );
}

function useNativeCameraGestures({
  camera,
  cameraOrthographicScaleRef,
  cameraProjectionRef,
  gl,
  invalidate,
  onCameraChangeRef,
  onCameraInteractionEndRef,
  onCameraInteractionStartRef,
  rotationModeRef,
  targetRef,
  trackerRef,
  wheelCommitTimerRef,
}: {
  camera: Camera;
  cameraOrthographicScaleRef: MutableRefObject<number | null>;
  cameraProjectionRef: MutableRefObject<Viewport3DCameraProjection>;
  gl: { domElement: HTMLElement };
  invalidate: () => void;
  onCameraChangeRef: MutableRefObject<(camera: Viewport3DCameraChange) => Promise<void> | void>;
  onCameraInteractionEndRef: MutableRefObject<(() => void) | undefined>;
  onCameraInteractionStartRef: MutableRefObject<(() => void) | undefined>;
  rotationModeRef: MutableRefObject<Viewport3DRotationMode>;
  targetRef: MutableRefObject<Vector3>;
  trackerRef: MutableRefObject<Viewport3DResourceTracker>;
  wheelCommitTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}): void {
  useEffect(() => {
    const element = gl.domElement;
    const gestureRef: { current: NativeGestureState | null } = { current: null };
    const localCameraStoreDirtyRef: { current: boolean } = { current: false };
    const lastLocalCameraSyncAtRef: { current: number | null } = { current: null };
    const onCameraInteractionEndCleanup = onCameraInteractionEndRef.current;
    const suppressContextMenuUntilRef = { current: 0 };

    const flushWheelCommit = ({
      endInteraction,
    }: {
      endInteraction: boolean;
    }) => {
      if (!wheelCommitTimerRef.current) return;
      clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = null;
      const isOrthographic = cameraProjectionRef.current === "orthographic";
      commitCurrentCamera({
        camera,
        onCameraChange: onCameraChangeRef.current,
        orthographicScale: isOrthographic
          ? resolveViewport3DCurrentOrthographicScale({
              camera,
              fallbackScale: cameraOrthographicScaleRef.current,
              viewportHeightPixels: resolveViewport3DElementSize(element).height,
            })
          : undefined,
        projection: isOrthographic ? "orthographic" : undefined,
        syncStore: false,
        target: targetRef.current,
      });
      if (endInteraction) {
        onCameraInteractionEndRef.current?.();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target !== element) return;
      const mode = shouldHandleViewport3DNativeCameraPan(event)
        ? "pan"
        : shouldHandleViewport3DNativeCameraOrbit(event)
          ? "orbit"
          : null;
      if (!mode) return;

      flushWheelCommit({ endInteraction: false });
      if (mode === "pan") {
        stopCameraEvent(event);
        suppressContextMenuUntilRef.current = Date.now() + 1_500;
      }
      captureViewport3DPointer(element, event.pointerId);
      localCameraStoreDirtyRef.current = false;
      lastLocalCameraSyncAtRef.current = null;
      onCameraInteractionStartRef.current?.();
      gestureRef.current = {
        hasDragged: false,
        lastX: event.clientX,
        lastY: event.clientY,
        mode,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      if (!gesture.hasDragged && !gestureMovedPastThreshold(gesture, event)) {
        return;
      }
      gesture.hasDragged = true;
      stopCameraEvent(event);

      const viewportSize = resolveViewport3DElementSize(element);
      const deltaX = event.clientX - gesture.lastX;
      const deltaY = event.clientY - gesture.lastY;
      const target = targetRef.current;
      const didMove =
        gesture.mode === "pan"
          ? applyViewport3DNativeCameraPan({
              camera,
              deltaX,
              deltaY,
              target,
              viewportHeightPixels: viewportSize.height,
              viewportWidthPixels: viewportSize.width,
            })
          : applyViewport3DNativeCameraOrbit({
              camera,
              deltaX,
              deltaY,
              rotationMode: rotationModeRef.current,
              target,
              viewportHeightPixels: viewportSize.height,
            });

      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      if (!didMove) return;

      const nowMs =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (
        resolveViewport3DLocalCameraSyncDue({
          lastSyncedAtMs: lastLocalCameraSyncAtRef.current,
          nowMs,
        })
      ) {
        syncLocalCameraStore({ camera, target });
        localCameraStoreDirtyRef.current = false;
        lastLocalCameraSyncAtRef.current = nowMs;
      } else {
        localCameraStoreDirtyRef.current = true;
      }
      invalidate();
      trackerRef.current.recordDirtyFrame(
        gesture.mode === "pan" ? "camera-native-pan" : "camera-native-orbit",
      );
    };

    const finishGesture = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      gestureRef.current = null;
      const syncStore = localCameraStoreDirtyRef.current;
      localCameraStoreDirtyRef.current = false;
      lastLocalCameraSyncAtRef.current = null;
      releaseViewport3DPointer(element, event.pointerId);
      if (gesture.mode === "pan") {
        suppressContextMenuUntilRef.current = Date.now() + 1_500;
      }
      if (!gesture.hasDragged && gesture.mode === "orbit") {
        onCameraInteractionEndRef.current?.();
        return;
      }

      stopCameraEvent(event);
      commitCurrentCamera({
        camera,
        onCameraChange: onCameraChangeRef.current,
        syncStore,
        target: targetRef.current,
      });
      invalidate();
      trackerRef.current.recordDirtyFrame(
        gesture.mode === "pan"
          ? "camera-native-pan-end"
          : "camera-native-orbit-end",
      );
      onCameraInteractionEndRef.current?.();
    };

    const handleContextMenu = (event: MouseEvent) => {
      const eventTarget = event.target;
      const isCanvasEvent =
        eventTarget === element ||
        eventTarget instanceof Node &&
          element.contains(eventTarget);
      const shouldSuppressContextMenu =
        isCanvasEvent || Date.now() <= suppressContextMenuUntilRef.current;
      if (!shouldSuppressContextMenu) return;
      stopCameraEvent(event);
    };

    element.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", finishGesture, { capture: true });
    window.addEventListener("pointercancel", finishGesture, { capture: true });
    window.addEventListener("contextmenu", handleContextMenu, { capture: true });

    return () => {
      if (gestureRef.current) {
        releaseViewport3DPointer(element, gestureRef.current.pointerId);
        onCameraInteractionEndCleanup?.();
      }
      gestureRef.current = null;
      element.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", finishGesture, { capture: true });
      window.removeEventListener("pointercancel", finishGesture, { capture: true });
      window.removeEventListener("contextmenu", handleContextMenu, { capture: true });
    };
  }, [
    camera,
    cameraOrthographicScaleRef,
    cameraProjectionRef,
    gl.domElement,
    invalidate,
    onCameraChangeRef,
    onCameraInteractionEndRef,
    onCameraInteractionStartRef,
    rotationModeRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  ]);
}

function resolveViewport3DCurrentOrthographicScale({
  camera,
  fallbackScale,
  viewportHeightPixels,
}: {
  camera: Camera;
  fallbackScale: number | null;
  viewportHeightPixels: number;
}): number {
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

  return fallbackScale ?? WHEEL_ZOOM_MIN_DISTANCE;
}

function applyViewport3DOrthographicZoomScale({
  camera,
  scale,
  viewportHeightPixels,
}: {
  camera: Camera;
  scale: number;
  viewportHeightPixels: number;
}): void {
  const orthographicCamera = camera as Camera & {
    isOrthographicCamera?: boolean;
    updateProjectionMatrix?: () => void;
    zoom?: number;
  };
  if (!orthographicCamera.isOrthographicCamera || viewportHeightPixels <= 0) {
    return;
  }

  orthographicCamera.zoom = clampNumber(viewportHeightPixels / scale, 1e-3, 1e12);
  orthographicCamera.updateProjectionMatrix?.();
}

function useWheelZoom({
  camera,
  cameraOrthographicScaleRef,
  cameraProjectionRef,
  gl,
  invalidate,
  onCameraChangeRef,
  onCameraInteractionEndRef,
  onCameraInteractionStartRef,
  targetRef,
  trackerRef,
  wheelCommitTimerRef,
}: {
  camera: Camera;
  cameraOrthographicScaleRef: MutableRefObject<number | null>;
  cameraProjectionRef: MutableRefObject<Viewport3DCameraProjection>;
  gl: { domElement: HTMLElement };
  invalidate: () => void;
  onCameraChangeRef: MutableRefObject<(camera: Viewport3DCameraChange) => Promise<void> | void>;
  onCameraInteractionEndRef: MutableRefObject<(() => void) | undefined>;
  onCameraInteractionStartRef: MutableRefObject<(() => void) | undefined>;
  targetRef: MutableRefObject<Vector3>;
  trackerRef: MutableRefObject<Viewport3DResourceTracker>;
  wheelCommitTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}): void {
  useEffect(() => {
    const element = gl.domElement;
    const fallbackDirection = new Vector3(1, 0.72, 1).normalize();
    const onCameraInteractionEndCleanup = onCameraInteractionEndRef.current;
    const offset = new Vector3();

    const handleWheel = (event: WheelEvent) => {
      stopCameraEvent(event);
      onCameraInteractionStartRef.current?.();

      const target = targetRef.current;
      if (cameraProjectionRef.current === "orthographic") {
        const viewportSize = resolveViewport3DElementSize(element);
        const currentScale = resolveViewport3DCurrentOrthographicScale({
          camera,
          fallbackScale: cameraOrthographicScaleRef.current,
          viewportHeightPixels: viewportSize.height,
        });
        const nextScale = resolveViewport3DOrthographicWheelScale(
          currentScale,
          event.deltaY,
        );
        applyViewport3DOrthographicZoomScale({
          camera,
          scale: nextScale,
          viewportHeightPixels: viewportSize.height,
        });
        applyCameraLookAt(camera, target);
        syncLocalCameraStore({
          camera,
          orthographicScale: nextScale,
          projection: "orthographic",
          target,
        });
        invalidate();
        trackerRef.current.recordDirtyFrame("camera-wheel");

        if (wheelCommitTimerRef.current) {
          clearTimeout(wheelCommitTimerRef.current);
        }
        wheelCommitTimerRef.current = setTimeout(() => {
          wheelCommitTimerRef.current = null;
          commitCurrentCamera({
            camera,
            onCameraChange: onCameraChangeRef.current,
            orthographicScale: nextScale,
            projection: "orthographic",
            syncStore: false,
            target,
          });
          onCameraInteractionEndRef.current?.();
        }, WHEEL_CAMERA_COMMIT_DELAY_MS);
        return;
      }

      offset.copy(camera.position).sub(target);
      const currentDistance = offset.length();
      const nextDistance = resolveWheelZoomDistance(currentDistance, event.deltaY);
      const direction =
        currentDistance > 0 ? offset.normalize() : fallbackDirection;

      camera.position.copy(target).addScaledVector(direction, nextDistance);
      applyCameraLookAt(camera, target);
      syncLocalCameraStore({ camera, target });
      invalidate();
      trackerRef.current.recordDirtyFrame("camera-wheel");

      if (wheelCommitTimerRef.current) {
        clearTimeout(wheelCommitTimerRef.current);
      }
      wheelCommitTimerRef.current = setTimeout(() => {
        wheelCommitTimerRef.current = null;
        commitCurrentCamera({
          camera,
          onCameraChange: onCameraChangeRef.current,
          syncStore: false,
          target,
        });
        onCameraInteractionEndRef.current?.();
      }, WHEEL_CAMERA_COMMIT_DELAY_MS);
    };

    element.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });

    return () => {
      element.removeEventListener("wheel", handleWheel, { capture: true });
      if (wheelCommitTimerRef.current) {
        clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = null;
        onCameraInteractionEndCleanup?.();
      }
    };
  }, [
    camera,
    cameraOrthographicScaleRef,
    cameraProjectionRef,
    gl.domElement,
    invalidate,
    onCameraChangeRef,
    onCameraInteractionEndRef,
    onCameraInteractionStartRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  ]);
}

export function OrbitCameraControls({
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  rotationMode,
  tracker,
}: {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  rotationMode: Viewport3DRotationMode;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, gl, invalidate } = useThree();
  const targetRef = useRef(new Vector3(...cameraState.target));
  const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCameraChangeRef = useLatestRef(onCameraChange);
  const onCameraInteractionEndRef = useLatestRef(onCameraInteractionEnd);
  const onCameraInteractionStartRef = useLatestRef(onCameraInteractionStart);
  const cameraOrthographicScaleRef = useLatestRef(cameraOrthographicScale);
  const cameraProjectionRef = useLatestRef(cameraProjection);
  const rotationModeRef = useLatestRef(rotationMode);
  const trackerRef = useLatestRef(tracker);

  useEffect(() => {
    targetRef.current.set(...cameraState.target);
  }, [cameraState.target]);

  useEffect(() => {
    applyViewport3DCameraUp(camera, cameraState.up);
    invalidate();
    tracker.recordDirtyFrame("camera-up");
  }, [camera, cameraState.up, invalidate, tracker]);

  const recordCameraReady = useCallback(() => {
    tracker.recordDirtyFrame("camera-control");
  }, [tracker]);

  useEffect(() => {
    recordCameraReady();
  }, [recordCameraReady]);

  useNativeCameraGestures({
    camera,
    cameraOrthographicScaleRef,
    cameraProjectionRef,
    gl,
    invalidate,
    onCameraChangeRef,
    onCameraInteractionEndRef,
    onCameraInteractionStartRef,
    rotationModeRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  });

  useWheelZoom({
    camera,
    cameraOrthographicScaleRef,
    cameraProjectionRef,
    gl,
    invalidate,
    onCameraChangeRef,
    onCameraInteractionEndRef,
    onCameraInteractionStartRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  });

  return null;
}
