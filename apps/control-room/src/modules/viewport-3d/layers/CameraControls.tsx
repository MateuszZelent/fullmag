"use client";

import { OrbitControls as DreiOrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";

import { MathUtils, PerspectiveCamera, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES } from "../viewport3dCameraFov";
import { sameTuple3 } from "../viewport3dMath";
import { scheduleViewport3DCameraRestCommit, VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS } from "./viewport3DCameraRestCommit";
import { resolveViewport3DCameraDepthRange } from "./viewport3DCameraClip";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { viewport3dStore, type Viewport3DCameraProjection, type Viewport3DCameraState } from "../viewport3dStore";
import {
  beginViewport3DCameraGesture,
  cancelViewport3DCameraGesture,
  endViewport3DCameraGesture,
  markViewport3DCameraGestureChanged,
  settleViewport3DCameraGesture,
  viewport3DCameraGestureActive,
  viewport3DCameraGestureEpoch,
  viewport3DCameraGestureSource,
  type Viewport3DCameraGestureRef,
} from "./viewport3DCameraGesture";

import {
  installViewport3DCameraTrajectoryProbeForBrowser,
  recordViewport3DCameraTrajectorySample,
  type Viewport3DCameraTrajectoryReason,
} from "./viewport3DCameraTrajectoryProbe";

interface Viewport3DCameraControlsDiagnostics {
  cameraNear: number | null;
  cameraFar: number | null;
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
import { VIEWPORT_3D_WORLD_UP } from "../viewport3dCameraModel";
import type { Viewport3DOrbitDebugStore } from "../model/viewport3DOrbitDebugStore";
import { type OrbitControlsHandle, type Viewport3DOrbitDebugAngles, normalizeViewport3DOrbitDebugAngles, resolveViewport3DOrbitDebugControlDeltas, tuple3, type Viewport3DCameraChange, isDefaultCameraState, shouldAutoFitViewport3DBoundsChange, resolveViewport3DCameraFit, applyViewport3DWorldUp, shouldPreserveViewport3DAutoFitAgainstDefaultCamera, shouldApplyViewport3DCameraState, resolveViewport3DCameraInteractionOptions, installScaleAwareOrbitChange, FALLBACK_CAMERA_BOUNDS, resolveViewport3DAutoFitOrbitTarget, shouldSyncCameraControlsPose, resolveViewport3DOrbitDebugStep, shouldApplyViewport3DOrbitDebugAngles, commitOrbitCameraEnd, ORBIT_DEBUG_TWO_PI } from "./CameraControls.model";

export { VIEWPORT_3D_WORLD_UP } from "../viewport3dCameraModel";

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
  const { camera, size } = useThree();
  const invalidate = useBatchedInvalidate("camera");
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
    const fitRequested = handledFitRevisionRef.current !== fitRevision;
    const resetRequested =
      handledResetCameraRevisionRef.current !== resetCameraRevision;
    if (viewport3DCameraGestureActive(cameraGestureRef)) {
      if (!fitRequested && !resetRequested) return;
      cancelViewport3DCameraGesture(
        cameraGestureRef,
        viewport3DCameraGestureEpoch(cameraGestureRef),
      );
    }
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
      fitRequested ||
      resetRequested ||
      shouldAutoFitInitialBounds ||
      shouldAutoFitChangedBounds;
    if (!shouldFit) return;

    const perspectiveCamera = camera instanceof PerspectiveCamera;
    const fit = resolveViewport3DCameraFit(bounds, {
      aspect: perspectiveCamera
        ? size.width / Math.max(size.height, 1)
        : 1,
      fovDegrees: perspectiveCamera
        ? camera.fov
        : DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES,
    });

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
    lastAutoFitCameraStateRef.current =
      resetRequested || (!fitRequested && !resetRequested)
        ? nextCamera
        : null;
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
    size,
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
    cameraNear: "near" in camera && typeof camera.near === "number" ? camera.near : null,
    cameraFar: "far" in camera && typeof camera.far === "number" ? camera.far : null,
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
  orbitDebugStore?: Viewport3DOrbitDebugStore;
  tracker: Viewport3DResourceTracker;
  interactionBlocked?: boolean;
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
  orbitDebugStore,
  tracker,
}: OrbitCameraControlsProps) {
  const { camera, size } = useThree();
  const invalidate = useBatchedInvalidate("camera");
  const gl = useThree((state) => state.gl);
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const options = resolveViewport3DCameraInteractionOptions();
  const handledOrbitDebugRevisionRef = useRef(orbitDebugRevision);
  const handledOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const pendingOrbitDebugCommitRevisionRef = useRef(orbitDebugCommitRevision);
  const orbitDebugAnimatingRef = useRef(false);
  const [orbitDebugTargetAngles, setOrbitDebugTargetAngles] = useState(() =>
    normalizeViewport3DOrbitDebugAngles(orbitDebugAngles),
  );
  const controlsSyncingRef = useRef(false);
  const cameraGestureEndedRef = useRef(false);
  const activeGestureEpochRef = useRef<number | null>(null);
  const trajectoryFrameRef = useRef(0);
  const suppressNextRestCommitRef = useRef(false);
  const cameraControlsPoseCommitCancelRef = useRef<(() => void) | null>(null);
  const controlsMovingRef = useRef(false);

  const recordCameraTrajectory = useCallback((
    reason: Viewport3DCameraTrajectoryReason,
    epoch: number,
  ) => {
    const controls = controlsRef.current;
    const controlTarget = controls?.target?.toArray();
    const target = controlTarget ? tuple3(controlTarget) : cameraState.target;
    recordViewport3DCameraTrajectorySample({
      active: viewport3DCameraGestureActive(cameraGestureRef),
      committedCamera: null,
      epoch,
      frame: trajectoryFrameRef.current,
      liveCamera: {
        orthographicScale:
          cameraProjection === "orthographic"
            ? resolveViewport3DCurrentOrthographicScale({
                camera,
                fallbackScale: cameraOrthographicScale,
                viewportHeightPixels: size.height,
              })
            : null,
        position: tuple3(camera.position.toArray()),
        projection: cameraProjection,
        target,
        up: tuple3(camera.up.toArray()),
      },
      reason,
      registry: null,
      source: viewport3DCameraGestureSource(cameraGestureRef),
      storeCamera: viewport3dStore.getSnapshot().camera,
      timestamp: performance.now(),
    });
    trajectoryFrameRef.current += 1;
  }, [
    camera,
    cameraGestureRef,
    cameraOrthographicScale,
    cameraProjection,
    cameraState.target,
    size.height,
  ]);

  useEffect(() => {
    installViewport3DCameraTrajectoryProbeForBrowser();
  }, []);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    return installScaleAwareOrbitChange(
      controls,
      bounds?.radius ?? FALLBACK_CAMERA_BOUNDS.radius,
      () => !controlsSyncingRef.current && viewport3DCameraGestureActive(cameraGestureRef),
      (moving) => { controlsMovingRef.current = moving; },
      () => cameraGestureEndedRef.current,
    );
  }, [bounds?.radius, camera, cameraGestureRef]);

  useEffect(() => {
    if (viewport3DCameraGestureActive(cameraGestureRef)) return;
    const controls = controlsRef.current;
    let currentTarget = controls?.target?.toArray();
    if (!controls || !currentTarget) return;
    const currentPosition = camera.position.toArray();
    const perspectiveCamera = camera instanceof PerspectiveCamera;
    const fittedCamera = bounds
      ? resolveViewport3DCameraFit(bounds, {
          aspect: perspectiveCamera
            ? size.width / Math.max(size.height, 1)
            : 1,
          fovDegrees: perspectiveCamera
            ? camera.fov
            : DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES,
        })
      : null;
    const autoFitTarget = resolveViewport3DAutoFitOrbitTarget({
      cameraState,
      currentPosition: tuple3(currentPosition),
      fit: fittedCamera,
    });
    if (autoFitTarget && !sameTuple3(tuple3(currentTarget), autoFitTarget)) {
      controlsSyncingRef.current = true;
      try {
        controls.target.set(...autoFitTarget);
        controls.update();
        currentTarget = controls.target.toArray();
      } finally {
        controlsSyncingRef.current = false;
      }
      invalidate();
      tracker.recordDirtyFrame("camera-control-target");
    }
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
    size.height,
    size.width,
    tracker,
  ]);

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
      orbitDebugStore?.reportAngles(currentAngles);
    }
  }, [camera, orbitDebugStore]);

  useEffect(() => {
    if (handledOrbitDebugRevisionRef.current === orbitDebugRevision) return;
    handledOrbitDebugRevisionRef.current = orbitDebugRevision;
    setOrbitDebugTargetAngles(normalizeViewport3DOrbitDebugAngles(orbitDebugAngles));
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
    setOrbitDebugTargetAngles,
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

    const targetAngles = orbitDebugTargetAngles;
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
      recordCameraTrajectory(
        "commit",
        viewport3DCameraGestureEpoch(cameraGestureRef),
      );
      endViewport3DCameraGesture(cameraGestureRef);
    } else if (settled) {
      endViewport3DCameraGesture(cameraGestureRef);
    }

    invalidate();
    tracker.recordDirtyFrame("camera-orbit-debug");
  });

  // OrbitControls updates at priority -1; the debug transition above also runs
  // before this callback. Refresh only projection planes from the live pose,
  // without publishing intermediate poses or starting a demand-render loop.
  // Waiting for the debounced store commit would clip geometry during a dolly.
  useFrame(() => {
    const target = controlsRef.current?.target;
    if (!target) return;
    const forward = {
      x: target.x - camera.position.x,
      y: target.y - camera.position.y,
      z: target.z - camera.position.z,
    };
    const clip = resolveViewport3DCameraDepthRange(
      bounds, camera.position, forward, Math.hypot(forward.x, forward.y, forward.z),
    );
    const projectionCamera = camera as Camera & {
      near: number;
      far: number;
      updateProjectionMatrix(): void;
    };
    if (projectionCamera.near === clip.near && projectionCamera.far === clip.far) return;
    applyCameraClipping(camera, clip.near, clip.far);
    projectionCamera.updateProjectionMatrix();
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
    recordCameraTrajectory("commit", epoch);
    const currentAngles = readViewport3DOrbitDebugAngles(controls, camera);
    if (currentAngles) {
      orbitDebugStore?.reportAngles(currentAngles);
    }
    if (cameraGestureEndedRef.current) {
      settleViewport3DCameraGesture(cameraGestureRef, epoch);
      recordCameraTrajectory("settle", epoch);
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
    orbitDebugStore,
    recordCameraTrajectory,
    size.height,
  ]);

  const clearCameraControlsPoseCommit = useCallback(() => {
    cameraControlsPoseCommitCancelRef.current?.();
    cameraControlsPoseCommitCancelRef.current = null;
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
    if (cameraControlsPoseCommitCancelRef.current !== null) {
      if (!restart) return;
      clearCameraControlsPoseCommit();
    }
    cameraControlsPoseCommitCancelRef.current = scheduleViewport3DCameraRestCommit({
      delayMs: VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS,
      isCurrent: () => activeGestureEpochRef.current === epoch &&
        viewport3DCameraGestureActive(cameraGestureRef) && viewport3DCameraGestureEpoch(cameraGestureRef) === epoch,
      isMoving: () => controlsMovingRef.current,
      requestFrame: invalidate,
      commit: () => {
        cameraControlsPoseCommitCancelRef.current = null;
        commitCameraControlsPose(epoch);
      },
    });
  }, [cameraGestureRef, clearCameraControlsPoseCommit, commitCameraControlsPose, invalidate]);

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
    recordCameraTrajectory("change", epoch);
    if (cameraGestureEndedRef.current) {
      scheduleCameraControlsPoseCommit(epoch, { restart: true });
    }
  }, [
    cameraGestureRef,
    recordCameraTrajectory,
    scheduleCameraControlsPoseCommit,
    tracker,
  ]);

  const handleTransitionStart = useCallback(() => {
    if (controlsSyncingRef.current) return;
    clearCameraControlsPoseCommit();
    const previousEpoch = activeGestureEpochRef.current;
    if (previousEpoch !== null) {
      cancelViewport3DCameraGesture(cameraGestureRef, previousEpoch);
      onCameraInteractionEnd?.(previousEpoch);
    }
    cameraGestureEndedRef.current = false;
    controlsMovingRef.current = true;
    const epoch = beginViewport3DCameraGesture(cameraGestureRef, "orbit");
    if (epoch < 0) return;
    activeGestureEpochRef.current = epoch;
    onCameraInteractionStart?.(epoch);
    recordCameraTrajectory("start", epoch);
  }, [
    cameraGestureRef,
    clearCameraControlsPoseCommit,
    onCameraInteractionEnd,
    onCameraInteractionStart,
    recordCameraTrajectory,
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
      enabled={!props.interactionBlocked}
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

function normalizeOrbitDebugAzimuthFromControls(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = value % ORBIT_DEBUG_TWO_PI;
  return wrapped < 0 ? wrapped + ORBIT_DEBUG_TWO_PI : wrapped;
}
