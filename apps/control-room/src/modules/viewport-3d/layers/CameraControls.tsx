"use client";

import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { MOUSE, Vector3, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
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
}: {
  cameraPosition: [number, number, number];
  cameraUp?: [number, number, number];
  controlTarget: number[];
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
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
  };
  viewport3dStore.setCamera(nextCamera);
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
  const polar = clamp(
    Math.acos(clamp(vector.z / radius, -1, 1)) + polarDelta,
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
  applyViewport3DWorldUp(camera);
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

function sameVector(
  left: [number, number, number],
  right: [number, number, number],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function nearVector(
  left: [number, number, number],
  right: [number, number, number],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => Math.abs(value - right[index]) <= CAMERA_STATE_EPSILON,
    )
  );
}

function nearCameraState(
  left: Viewport3DCameraState,
  right: Viewport3DCameraState,
): boolean {
  return (
    nearVector(left.position, right.position) &&
    nearVector(left.target, right.target) &&
    nearVector(left.up ?? VIEWPORT_3D_WORLD_UP, right.up ?? VIEWPORT_3D_WORLD_UP)
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
    sameVector(cameraState.position, DEFAULT_VIEWPORT_3D_CAMERA_STATE.position) &&
    sameVector(cameraState.target, DEFAULT_VIEWPORT_3D_CAMERA_STATE.target)
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
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
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
    viewport3dStore.setCamera(state);
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
    viewport3dStore.setCamera(cameraState);
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
  target,
}: {
  camera: Camera;
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
  target: Vector3;
}): void {
  commitOrbitCameraEnd({
    cameraPosition: camera.position.toArray() as [number, number, number],
    cameraUp: camera.up.toArray() as [number, number, number],
    controlTarget: target.toArray(),
    onCameraChange,
  });
}

function syncLocalCameraStore(camera: Camera, target: Vector3): void {
  viewport3dStore.setCamera({
    position: camera.position.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
    up: camera.up.toArray() as [number, number, number],
  });
}

function stopCameraEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
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
  gl,
  invalidate,
  onCameraChangeRef,
  rotationModeRef,
  targetRef,
  trackerRef,
  wheelCommitTimerRef,
}: {
  camera: Camera;
  gl: { domElement: HTMLElement };
  invalidate: () => void;
  onCameraChangeRef: MutableRefObject<(camera: Viewport3DCameraState) => Promise<void> | void>;
  rotationModeRef: MutableRefObject<Viewport3DRotationMode>;
  targetRef: MutableRefObject<Vector3>;
  trackerRef: MutableRefObject<Viewport3DResourceTracker>;
  wheelCommitTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}): void {
  useEffect(() => {
    const element = gl.domElement;
    const gestureRef: { current: NativeGestureState | null } = { current: null };

    const flushWheelCommit = () => {
      if (!wheelCommitTimerRef.current) return;
      clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = null;
      commitCurrentCamera({
        camera,
        onCameraChange: onCameraChangeRef.current,
        target: targetRef.current,
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target !== element) return;
      const mode = shouldHandleViewport3DNativeCameraPan(event)
        ? "pan"
        : shouldHandleViewport3DNativeCameraOrbit(event)
          ? "orbit"
          : null;
      if (!mode) return;

      flushWheelCommit();
      if (mode === "pan") {
        stopCameraEvent(event);
      }
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

      invalidate();
      trackerRef.current.recordDirtyFrame(
        gesture.mode === "pan" ? "camera-native-pan" : "camera-native-orbit",
      );
    };

    const finishGesture = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      gestureRef.current = null;
      if (!gesture.hasDragged && gesture.mode === "orbit") {
        return;
      }

      stopCameraEvent(event);
      commitCurrentCamera({
        camera,
        onCameraChange: onCameraChangeRef.current,
        target: targetRef.current,
      });
      invalidate();
      trackerRef.current.recordDirtyFrame(
        gesture.mode === "pan"
          ? "camera-native-pan-end"
          : "camera-native-orbit-end",
      );
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (event.target !== element) return;
      stopCameraEvent(event);
    };

    element.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", finishGesture, { capture: true });
    window.addEventListener("pointercancel", finishGesture, { capture: true });
    window.addEventListener("contextmenu", handleContextMenu, { capture: true });

    return () => {
      gestureRef.current = null;
      element.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", finishGesture, { capture: true });
      window.removeEventListener("pointercancel", finishGesture, { capture: true });
      window.removeEventListener("contextmenu", handleContextMenu, { capture: true });
    };
  }, [
    camera,
    gl.domElement,
    invalidate,
    onCameraChangeRef,
    rotationModeRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  ]);
}

function useWheelZoom({
  camera,
  gl,
  invalidate,
  onCameraChangeRef,
  targetRef,
  trackerRef,
  wheelCommitTimerRef,
}: {
  camera: Camera;
  gl: { domElement: HTMLElement };
  invalidate: () => void;
  onCameraChangeRef: MutableRefObject<(camera: Viewport3DCameraState) => Promise<void> | void>;
  targetRef: MutableRefObject<Vector3>;
  trackerRef: MutableRefObject<Viewport3DResourceTracker>;
  wheelCommitTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}): void {
  useEffect(() => {
    const element = gl.domElement;
    const fallbackDirection = new Vector3(1, 0.72, 1).normalize();
    const offset = new Vector3();

    const handleWheel = (event: WheelEvent) => {
      stopCameraEvent(event);

      const target = targetRef.current;
      offset.copy(camera.position).sub(target);
      const currentDistance = offset.length();
      const nextDistance = resolveWheelZoomDistance(currentDistance, event.deltaY);
      const direction =
        currentDistance > 0 ? offset.normalize() : fallbackDirection;

      camera.position.copy(target).addScaledVector(direction, nextDistance);
      applyCameraLookAt(camera, target);
      syncLocalCameraStore(camera, target);
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
          target,
        });
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
      }
    };
  }, [
    camera,
    gl.domElement,
    invalidate,
    onCameraChangeRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  ]);
}

export function OrbitCameraControls({
  cameraState,
  onCameraChange,
  rotationMode,
  tracker,
}: {
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
  rotationMode: Viewport3DRotationMode;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, gl, invalidate } = useThree();
  const targetRef = useRef(new Vector3(...cameraState.target));
  const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCameraChangeRef = useLatestRef(onCameraChange);
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
    gl,
    invalidate,
    onCameraChangeRef,
    rotationModeRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  });

  useWheelZoom({
    camera,
    gl,
    invalidate,
    onCameraChangeRef,
    targetRef,
    trackerRef,
    wheelCommitTimerRef,
  });

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
