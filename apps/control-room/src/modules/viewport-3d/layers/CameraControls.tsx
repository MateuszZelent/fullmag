"use client";

import { OrbitControls, type OrbitControlsProps } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef } from "react";
import { Vector3, type Camera } from "three";

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
const WHEEL_ZOOM_INTENSITY = 0.0015;
const WHEEL_ZOOM_MIN_DISTANCE = 1e-12;
const WHEEL_ZOOM_MAX_DISTANCE = 1e-2;
const CAMERA_STATE_EPSILON = 1e-7;

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
  const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    applyViewport3DCameraUp(camera, cameraState.up);
    invalidate();
    tracker.recordDirtyFrame("camera-up");
  }, [camera, cameraState.up, invalidate, tracker]);

  useEffect(() => {
    const controls = controlsRef.current;
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
      makeDefault
      enableDamping={false}
      enableZoom={false}
      onChange={recordCameraControlChange}
      onEnd={(event) => recordCameraControlEnd(event as OrbitControlsEndEvent)}
      onStart={recordCameraControlStart}
    />
  );
}
