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

  useEffect(() => {
    const activeBounds = bounds ?? {
      center: [0, 0, 0] as [number, number, number],
      radius: 1,
      size: [1, 1, 1] as [number, number, number],
    };
    const [x, y, z] = activeBounds.center;
    const distance = activeBounds.radius * 2.8;
    const shouldFit =
      handledFitRevisionRef.current !== fitRevision ||
      handledResetCameraRevisionRef.current !== resetCameraRevision;
    const nextPosition: [number, number, number] = shouldFit
      ? [x + distance, y + distance * 0.72, z + distance]
      : cameraState.position;
    const nextTarget: [number, number, number] = shouldFit
      ? activeBounds.center
      : cameraState.target;

    camera.position.set(...nextPosition);
    camera.lookAt(...nextTarget);
    camera.updateProjectionMatrix();
    if (shouldFit) {
      handledFitRevisionRef.current = fitRevision;
      handledResetCameraRevisionRef.current = resetCameraRevision;
      viewport3dStore.setCamera({
        position: nextPosition,
        target: nextTarget,
      });
    }
    invalidate();
    tracker.recordDirtyFrame("camera");
  }, [
    bounds,
    camera,
    cameraState.position,
    cameraState.target,
    fitRevision,
    invalidate,
    resetCameraRevision,
    tracker,
  ]);

  return null;
}

export function OrbitCameraControls({
  tracker,
}: {
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, invalidate } = useThree();

  const handleChange = useCallback(() => {
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
      onChange={handleChange}
      onEnd={handleEnd}
    />
  );
}
