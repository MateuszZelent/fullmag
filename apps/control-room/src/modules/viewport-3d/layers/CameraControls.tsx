"use client";

import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef } from "react";
import { MOUSE, type Camera } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { nearTuple3, sameTuple3 } from "../viewport3dMath";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
} from "../viewport3dStore";

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

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>;

type OrbitMouseAction = (typeof MOUSE)[keyof typeof MOUSE];

interface Viewport3DCameraInteractionOptions {
  enableDamping: false;
  enablePan: true;
  enableZoom: true;
  mouseButtons: {
    LEFT: OrbitMouseAction;
    MIDDLE: OrbitMouseAction;
    RIGHT: OrbitMouseAction;
  };
  panSpeed: number;
  rotateSpeed: number;
  screenSpacePanning: true;
}

const FALLBACK_CAMERA_BOUNDS: Viewport3DBounds = {
  center: [0, 0, 0],
  radius: 1e-6,
  size: [1e-6, 1e-6, 1e-6],
};
export const VIEWPORT_3D_WORLD_UP: [number, number, number] = [0, 0, 1];
const CAMERA_STATE_EPSILON = 1e-7;

const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  enableDamping: false,
  enablePan: true,
  enableZoom: true,
  mouseButtons: {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  },
  panSpeed: 1,
  rotateSpeed: 1,
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
  }, [camera, cameraState, invalidate, tracker]);

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

export function OrbitCameraControls({
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  tracker,
}: {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  tracker: Viewport3DResourceTracker;
}) {
  const { camera, invalidate, size } = useThree();
  const controlsRef = useRef<OrbitControlsHandle>(null);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.target.set(...cameraState.target);
    controls.update();
    invalidate();
    tracker.recordDirtyFrame("camera-control-target");
  }, [cameraState.target, invalidate, tracker]);

  const handleChange = useCallback(() => {
    invalidate();
    tracker.recordDirtyFrame("camera-control");
  }, [invalidate, tracker]);

  const handleStart = useCallback(() => {
    onCameraInteractionStart?.();
  }, [onCameraInteractionStart]);

  const handleEnd = useCallback(() => {
    const target = controlsRef.current?.target.toArray() ?? cameraState.target;
    const orthographicScale =
      cameraProjection === "orthographic"
        ? resolveViewport3DCurrentOrthographicScale({
            camera,
            fallbackScale: cameraOrthographicScale,
            viewportHeightPixels: size.height,
          })
        : undefined;
    commitOrbitCameraEnd({
      cameraPosition: tuple3(camera.position.toArray()),
      cameraUp: tuple3(camera.up.toArray()),
      controlTarget: target,
      onCameraChange,
      orthographicScale,
      projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
    });
    onCameraInteractionEnd?.();
  }, [
    camera,
    cameraOrthographicScale,
    cameraProjection,
    cameraState.target,
    onCameraChange,
    onCameraInteractionEnd,
    size.height,
  ]);

  const options = resolveViewport3DCameraInteractionOptions();

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping={options.enableDamping}
      enablePan={options.enablePan}
      enableZoom={options.enableZoom}
      mouseButtons={options.mouseButtons}
      panSpeed={options.panSpeed}
      rotateSpeed={options.rotateSpeed}
      screenSpacePanning={options.screenSpacePanning}
      target={cameraState.target}
      onChange={handleChange}
      onEnd={handleEnd}
      onStart={handleStart}
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
