"use client";

import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  type Viewport3DCameraState,
} from "../viewport3dStore";

interface OrbitControlsEndEvent {
  target?: {
    target?: {
      toArray: () => number[];
    };
  };
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

export function resolveViewport3DCameraFit(
  bounds: Viewport3DBounds | null,
): Viewport3DCameraFit {
  const activeBounds = bounds ?? FALLBACK_CAMERA_BOUNDS;
  const [x, y, z] = activeBounds.center;
  const radius = Math.max(activeBounds.radius, 1e-12);
  const distance = radius * 2.8;
  const near = Math.max(distance / 10_000, 1e-12);
  const far = Math.max(distance * 10_000, near * 1_000, 1e-3);

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
  return left.every((value, index) => value === right[index]);
}

function isDefaultCameraState(cameraState: Viewport3DCameraState): boolean {
  return (
    sameVector(cameraState.position, DEFAULT_VIEWPORT_3D_CAMERA_STATE.position) &&
    sameVector(cameraState.target, DEFAULT_VIEWPORT_3D_CAMERA_STATE.target)
  );
}

export function CameraController({
  bounds,
  cameraState,
  fitRevision,
  resetCameraRevision,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
  cameraState: Viewport3DCameraState;
  fitRevision: number;
  resetCameraRevision: number;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, invalidate } = useThree();
  const handledFitRevisionRef = useRef(fitRevision);
  const handledResetCameraRevisionRef = useRef(resetCameraRevision);
  const autoFittedBoundsRef = useRef<string | null>(null);
  // Store cameraState in a ref so the fit/reset effect doesn't re-fire
  // when OrbitControls updates the store (which it does on every drag-end).
  const cameraStateRef = useRef(cameraState);

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
    const shouldFit =
      handledFitRevisionRef.current !== fitRevision ||
      handledResetCameraRevisionRef.current !== resetCameraRevision ||
      shouldAutoFitInitialBounds;
    if (!shouldFit) return;

    const fit = resolveViewport3DCameraFit(bounds);

    camera.position.set(...fit.position);
    camera.lookAt(...fit.target);
    applyCameraClipping(camera, fit.near, fit.far);
    camera.updateProjectionMatrix();
    handledFitRevisionRef.current = fitRevision;
    handledResetCameraRevisionRef.current = resetCameraRevision;
    autoFittedBoundsRef.current = nextBoundsSignature;
    viewport3dStore.setCamera({
      position: fit.position,
      target: fit.target,
    });
    invalidate();
    tracker.recordDirtyFrame("camera-fit");
  }, [bounds, camera, fitRevision, invalidate, resetCameraRevision, tracker]);

  // Initial camera placement (once, on mount)
  useEffect(() => {
    const state = cameraStateRef.current;
    camera.position.set(...state.position);
    camera.lookAt(...state.target);
    camera.updateProjectionMatrix();
    invalidate();
    tracker.recordDirtyFrame("camera-init");
    // Intentionally runs only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export function OrbitCameraControls({
  tracker,
}: {
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, invalidate } = useThree();

  const recordCameraControlChange = useCallback(() => {
    invalidate();
    tracker.recordDirtyFrame("camera-control");
  }, [invalidate, tracker]);

  const handleEnd = useCallback(
    (event?: unknown) => {
      const controls = event as OrbitControlsEndEvent | undefined;
      const target = controls?.target?.target?.toArray();
      if (!target || target.length < 3) return;

      viewport3dStore.setCamera({
        position: camera.position.toArray() as [number, number, number],
        target: [target[0] ?? 0, target[1] ?? 0, target[2] ?? 0],
      });
    },
    [camera],
  );

  return (
    <OrbitControls
      makeDefault
      enableDamping={false}
      onChange={recordCameraControlChange}
      onEnd={handleEnd}
    />
  );
}
