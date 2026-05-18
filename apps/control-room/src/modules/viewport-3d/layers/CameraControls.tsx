"use client";

import { OrbitControls, type OrbitControlsProps } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef, MutableRefObject } from "react";
import { MOUSE, Vector3, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  type Viewport3DCameraState,
} from "../viewport3dStore";

type OrbitControlsEndEvent = Parameters<
  NonNullable<OrbitControlsProps["onEnd"]>
>[0] & {
  target?: {
    target?: {
      toArray: () => number[];
    };
  };
};

interface Viewport3DNativeCameraPanEvent {
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface Viewport3DNativeCameraOrbitEvent {
  button: number;
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
  void Promise.resolve(onCameraChange(nextCamera)).catch(() => undefined);
}

interface Viewport3DCameraFit {
  far: number;
  near: number;
  position: [number, number, number];
  target: [number, number, number];
}

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
  rotateSpeed: 1,
  screenSpacePanning: true,
} satisfies Viewport3DCameraInteractionOptions;

export function resolveViewport3DCameraInteractionOptions(): Viewport3DCameraInteractionOptions {
  return VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS;
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
  camera.updateMatrix();
  camera.updateMatrixWorld();
  return true;
}

export function applyViewport3DNativeCameraOrbit({
  camera,
  deltaX,
  deltaY,
  target,
  viewportHeightPixels,
}: {
  camera: Camera;
  deltaX: number;
  deltaY: number;
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

  camera.updateMatrixWorld();
  const offset = new Vector3().copy(camera.position).sub(target);
  const focusDistance = offset.length();
  if (focusDistance <= 0) return false;

  const yawAngle =
    -2 * Math.PI * deltaX * VIEWPORT_3D_ORBIT_ROTATE_SPEED / viewportHeightPixels;
  const pitchAngle =
    -2 * Math.PI * deltaY * VIEWPORT_3D_ORBIT_ROTATE_SPEED / viewportHeightPixels;
  const worldUp = new Vector3(...VIEWPORT_3D_WORLD_UP);
  const forward = target.clone().sub(camera.position).normalize();
  const right = new Vector3()
    .setFromMatrixColumn(camera.matrix, 0)
    .applyAxisAngle(worldUp, yawAngle)
    .normalize();

  forward.applyAxisAngle(worldUp, yawAngle);
  const pitchedForward = forward.clone().applyAxisAngle(right, pitchAngle);
  if (Math.abs(pitchedForward.normalize().dot(worldUp)) < 0.98) {
    forward.copy(pitchedForward);
  }

  target.copy(camera.position).addScaledVector(forward, focusDistance);
  applyViewport3DWorldUp(camera);
  camera.lookAt(target);
  camera.updateMatrix();
  camera.updateMatrixWorld();
  return true;
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
  panOffset.add(new Vector3().setFromMatrixColumn(objectMatrix, 0).multiplyScalar(-distance));
}

function addViewport3DPanUp(
  panOffset: Vector3,
  distance: number,
  objectMatrix: Camera["matrix"],
): void {
  panOffset.add(new Vector3().setFromMatrixColumn(objectMatrix, 1).multiplyScalar(distance));
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

function applyViewport3DCameraUp(camera: Camera, up: [number, number, number] | undefined): void {
  camera.up.set(...(up ?? VIEWPORT_3D_WORLD_UP));
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
  // Camera ownership has three paths: remote visualization resources update the
  // store, this controller applies store state to Three.js, and OrbitControls
  // commits user interaction through onCameraChange. Keep the paths deduped.
  const { camera, invalidate } = useThree();
  const handledFitRevisionRef = useRef(fitRevision);
  const handledResetCameraRevisionRef = useRef(resetCameraRevision);
  const autoFittedBoundsRef = useRef<string | null>(null);
  const lastAutoFitCameraStateRef = useRef<Viewport3DCameraState | null>(null);
  const appliedCameraStateRef = useRef<Viewport3DCameraState | null>(null);
  const onCameraChangeRef = useRef(onCameraChange);
  // Store cameraState in a ref so the fit/reset effect doesn't re-fire
  // when OrbitControls updates the store (which it does on every drag-end).
  const cameraStateRef = useRef(cameraState);

  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  useEffect(() => {
    cameraStateRef.current = cameraState;
  }, [cameraState]);

  // Only runs when bounds change or a fit/reset command is issued.
  // Does NOT depend on cameraState to avoid the store write → re-render loop.
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

  // Initial camera placement (once, on mount)
  useEffect(() => {
    const state = cameraStateRef.current;
    applyViewport3DCameraUp(camera, state.up);
    camera.position.set(...state.position);
    camera.lookAt(...state.target);
    camera.updateProjectionMatrix();
    appliedCameraStateRef.current = state;
    viewport3dStore.setCamera(state);
    invalidate();
    tracker.recordDirtyFrame("camera-init");
    // Intentionally runs only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      appliedCameraStateRef.current &&
      nearCameraState(appliedCameraStateRef.current, cameraState)
    ) {
      return;
    }
    applyViewport3DCameraUp(camera, cameraState.up);
    camera.position.set(...cameraState.position);
    camera.lookAt(...cameraState.target);
    camera.updateProjectionMatrix();
    appliedCameraStateRef.current = cameraState;
    viewport3dStore.setCamera(cameraState);
    invalidate();
    tracker.recordDirtyFrame("camera-resource");
  }, [camera, cameraState, invalidate, tracker]);

  return null;
}

export function OrbitCameraControls({
  cameraState,
  onCameraChange,
  tracker,
}: {
  cameraState: Viewport3DCameraState;
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, gl, invalidate } = useThree();
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const flushWheelCommitRef = useRef<(() => void) | null>(null);
  const onCameraChangeRef = useRef(onCameraChange);
  const nativeGestureRef = useRef<{
    controlsEnabled: boolean | null;
    lastX: number;
    lastY: number;
    mode: "orbit" | "pan";
    pointerId: number;
  } | null>(null);
  const nativeTargetRef = useRef(new Vector3(...cameraState.target));
  const trackerRef = useRef(tracker);
  const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionOptions = resolveViewport3DCameraInteractionOptions();

  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  useEffect(() => {
    trackerRef.current = tracker;
  }, [tracker]);

  useEffect(() => {
    applyViewport3DCameraUp(camera, cameraState.up);
    invalidate();
    tracker.recordDirtyFrame("camera-up");
  }, [camera, cameraState.up, invalidate, tracker]);

  useEffect(() => {
    const controls = controlsRef.current;
    nativeTargetRef.current.set(...cameraState.target);
    if (!controls) return;
    controls.target.set(...cameraState.target);
    controls.update();
    invalidate();
    tracker.recordDirtyFrame("camera-controls-target");
  }, [cameraState.target, invalidate, tracker]);

  const recordCameraControlChange = useCallback(() => {
    invalidate();
    tracker.recordDirtyFrame("camera-control");
  }, [invalidate, tracker]);

  const recordCameraControlStart = useCallback(() => {
    flushWheelCommitRef.current?.();
  }, []);

  const recordCameraControlEnd = useCallback(
    (event: OrbitControlsEndEvent) => {
      flushWheelCommitRef.current?.();
      const controlTarget = event.target?.target?.toArray();
      commitOrbitCameraEnd({
        cameraPosition: camera.position.toArray() as [number, number, number],
        cameraUp: camera.up.toArray() as [number, number, number],
        controlTarget: controlTarget ?? cameraState.target,
        onCameraChange,
      });
      invalidate();
      tracker.recordDirtyFrame("camera-control-end");
    },
    [camera, cameraState.target, invalidate, onCameraChange, tracker],
  );

  useEffect(() => {
    const element = gl.domElement;

    const stopNativePanEvent = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target !== element) return;
      const mode = shouldHandleViewport3DNativeCameraPan(event)
        ? "pan"
        : shouldHandleViewport3DNativeCameraOrbit(event)
          ? "orbit"
          : null;
      if (!mode) return;

      stopNativePanEvent(event);
      flushWheelCommitRef.current?.();
      const controls = controlsRef.current;
      if (controls) {
        nativeTargetRef.current.copy(controls.target);
      }
      nativeGestureRef.current = {
        controlsEnabled: controls?.enabled ?? null,
        lastX: event.clientX,
        lastY: event.clientY,
        mode,
        pointerId: event.pointerId,
      };
      if (controls) {
        controls.enabled = false;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const activeGesture = nativeGestureRef.current;
      if (!activeGesture || activeGesture.pointerId !== event.pointerId) return;

      stopNativePanEvent(event);
      const target = nativeTargetRef.current;
      const viewportSize = resolveViewport3DElementSize(element);
      const deltaX = event.clientX - activeGesture.lastX;
      const deltaY = event.clientY - activeGesture.lastY;

      const didMove =
        activeGesture.mode === "pan"
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
              target,
              viewportHeightPixels: viewportSize.height,
            });
      activeGesture.lastX = event.clientX;
      activeGesture.lastY = event.clientY;
      if (!didMove) return;

      controlsRef.current?.target.copy(target);
      invalidate();
      trackerRef.current.recordDirtyFrame(
        activeGesture.mode === "pan" ? "camera-native-pan" : "camera-native-orbit",
      );
    };

    const finishNativePan = (event: PointerEvent) => {
      const activeGesture = nativeGestureRef.current;
      if (!activeGesture || activeGesture.pointerId !== event.pointerId) return;

      stopNativePanEvent(event);
      nativeGestureRef.current = null;
      const controls = controlsRef.current;
      if (controls && activeGesture.controlsEnabled !== null) {
        controls.enabled = activeGesture.controlsEnabled;
        controls.target.copy(nativeTargetRef.current);
      }
      commitOrbitCameraEnd({
        cameraPosition: camera.position.toArray() as [number, number, number],
        cameraUp: camera.up.toArray() as [number, number, number],
        controlTarget: nativeTargetRef.current.toArray(),
        onCameraChange: onCameraChangeRef.current,
      });
      invalidate();
      trackerRef.current.recordDirtyFrame(
        activeGesture.mode === "pan"
          ? "camera-native-pan-end"
          : "camera-native-orbit-end",
      );
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (event.target !== element) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
    });
    window.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    window.addEventListener("pointerup", finishNativePan, {
      capture: true,
    });
    window.addEventListener("contextmenu", handleContextMenu, {
      capture: true,
    });

    const controlsForCleanup = controlsRef.current;
    return () => {
      const activeGesture = nativeGestureRef.current;
      const controls = controlsForCleanup;
      if (activeGesture && controls && activeGesture.controlsEnabled !== null) {
        controls.enabled = activeGesture.controlsEnabled;
      }
      nativeGestureRef.current = null;
      window.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      window.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      window.removeEventListener("pointerup", finishNativePan, {
        capture: true,
      });
      window.removeEventListener("contextmenu", handleContextMenu, {
        capture: true,
      });
    };
  }, [
    camera,
    gl.domElement,
    invalidate,
  ]);

  useEffect(() => {
    const element = gl.domElement;
    const fallbackDirection = new Vector3(1, 0.72, 1).normalize();
    const offset = new Vector3();
    const target = new Vector3();

    const commitWheelCamera = () => {
      if (wheelCommitTimerRef.current) {
        clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = null;
      }
      const controlTarget =
        controlsRef.current?.target.toArray() ?? cameraState.target;
      commitOrbitCameraEnd({
        cameraPosition: camera.position.toArray() as [number, number, number],
        cameraUp: camera.up.toArray() as [number, number, number],
        controlTarget,
        onCameraChange,
      });
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      target.copy(
        controlsRef.current?.target ?? new Vector3(...cameraState.target),
      );
      offset.copy(camera.position).sub(target);
      const currentDistance = offset.length();
      const nextDistance = resolveWheelZoomDistance(
        currentDistance,
        event.deltaY,
      );
      const direction =
        currentDistance > 0 ? offset.normalize() : fallbackDirection;

      camera.position.copy(target).addScaledVector(direction, nextDistance);
      camera.updateProjectionMatrix();
      controlsRef.current?.update();
      invalidate();
      tracker.recordDirtyFrame("camera-wheel");

      if (wheelCommitTimerRef.current) {
        clearTimeout(wheelCommitTimerRef.current);
      }
      wheelCommitTimerRef.current = setTimeout(() => {
        commitWheelCamera();
      }, WHEEL_CAMERA_COMMIT_DELAY_MS);
    };

    flushWheelCommitRef.current = commitWheelCamera;
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
      if (flushWheelCommitRef.current === commitWheelCamera) {
        flushWheelCommitRef.current = null;
      }
    };
  }, [
    camera,
    cameraState.target,
    gl.domElement,
    invalidate,
    onCameraChange,
    tracker,
  ]);

  return (
    <OrbitControls
      ref={controlsRef}
      domElement={gl.domElement}
      makeDefault
      enableDamping={interactionOptions.enableDamping}
      enablePan={interactionOptions.enablePan}
      enableZoom={interactionOptions.enableZoom}
      mouseButtons={interactionOptions.mouseButtons}
      onChange={recordCameraControlChange}
      onEnd={(event) => recordCameraControlEnd(event as OrbitControlsEndEvent)}
      onStart={recordCameraControlStart}
      panSpeed={interactionOptions.panSpeed}
      rotateSpeed={interactionOptions.rotateSpeed}
      screenSpacePanning={interactionOptions.screenSpacePanning}
    />
  );
}
