"use client";

import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
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
  // Store cameraState in a ref so the fit/reset effect doesn't re-fire
  // when OrbitControls updates the store (which it does on every drag-end).
  const cameraStateRef = useRef(cameraState);

  useEffect(() => {
    cameraStateRef.current = cameraState;
  }, [cameraState]);

  // Only runs when bounds change or a fit/reset command is issued.
  // Does NOT depend on cameraState to avoid the store write → re-render loop.
  useEffect(() => {
    const shouldFit =
      handledFitRevisionRef.current !== fitRevision ||
      handledResetCameraRevisionRef.current !== resetCameraRevision;
    if (!shouldFit) return;

    const activeBounds = bounds ?? {
      center: [0, 0, 0] as [number, number, number],
      radius: 1,
      size: [1, 1, 1] as [number, number, number],
    };
    const [x, y, z] = activeBounds.center;
    const distance = activeBounds.radius * 2.8;
    const nextPosition: [number, number, number] = [
      x + distance,
      y + distance * 0.72,
      z + distance,
    ];
    const nextTarget: [number, number, number] = activeBounds.center;

    camera.position.set(...nextPosition);
    camera.lookAt(...nextTarget);
    camera.updateProjectionMatrix();
    handledFitRevisionRef.current = fitRevision;
    handledResetCameraRevisionRef.current = resetCameraRevision;
    viewport3dStore.setCamera({
      position: nextPosition,
      target: nextTarget,
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
