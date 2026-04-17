"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import {
  OrthographicCamera,
  PerspectiveCamera,
  OrbitControls,
  TrackballControls,
} from "@react-three/drei";
import { getViewportQualityProfile, type ViewportQualityProfileId } from "./viewportQualityProfiles";
import ViewportGizmoStack from "./ViewportGizmoStack";
import { useCanvasHost } from "./useCanvasHost";
import ViewportTelemetryProbe from "./ViewportTelemetryProbe";
import {
  CAMERA_CONTROL_PROFILES,
  type CameraControlProfileId,
  createCameraStepLockState,
  applyCameraStepLock,
} from "../camera/cameraProfiles";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { useViewportTelemetryEntry } from "@/lib/debug/viewportTelemetry";

export type ShellProjection = "perspective" | "orthographic";
export type ShellNavigation = "trackball" | "cad";
export type ViewportFrameloopMode = "always" | "demand" | "never";

const DEFAULT_SHELL_TARGET: [number, number, number] = [0, 0, 0];

export interface ViewportRenderPolicy {
  mode: "always" | "demand" | "paused";
  hidden: boolean;
  interactionActive: boolean;
}

interface ScientificViewportShellProps {
  children: ReactNode;
  toolbar?: ReactNode;
  hud?: ReactNode;
  gizmos?: ReactNode;
  backgroundColor?: number;
  projection?: ShellProjection;
  navigation?: ShellNavigation;
  qualityProfile?: ViewportQualityProfileId;
  target?: [number, number, number];
  onViewCubeRotate?: (quat: THREE.Quaternion) => void;
  onResetView?: () => void;
  showOrientationSphere?: boolean;
  orientationSphereAxisConvention?: "identity" | "swapYZ";
  orientationSpherePositionClassName?: string;
  bridgeRef?: MutableRefObject<any> | null;
  controlsRef?: MutableRefObject<any> | null;
  onCanvasCreated?: (payload: { gl: THREE.WebGLRenderer; camera: THREE.Camera }) => void;
  onPointerMissed?: () => void;
  onCanvasContextMenu?: React.MouseEventHandler<Element>;
  renderDefaultGizmos?: boolean;
  renderPolicy?: Partial<ViewportRenderPolicy>;
  onInteractionChange?: (active: boolean) => void;
  controlProfile?: CameraControlProfileId;
  diagnosticOverrides?: {
    enableControls?: boolean;
    enableLights?: boolean;
    enableCanvasPointerMissedHandler?: boolean;
    enableCanvasContextMenuHandler?: boolean;
    enableCanvasCreatedHandler?: boolean;
    enableBridgeSync?: boolean;
    forceFrameloopMode?: ViewportFrameloopMode;
  };
  telemetryLabel?: string;
}

function ShellCamera({ projection }: { projection: ShellProjection }) {
  if (projection === "orthographic") {
    return (
      <OrthographicCamera
        makeDefault
        position={[3, 2.4, 3]}
        near={0.0001}
        far={10000}
        zoom={80}
      />
    );
  }
  return (
    <PerspectiveCamera
      makeDefault
      position={[3, 2.4, 3]}
      fov={45}
      near={0.0001}
      far={10000}
    />
  );
}

function ShellControls({
  navigation,
  target,
  controlsRef,
  controlProfile,
  onInteractionChange,
}: {
  navigation: ShellNavigation;
  target: [number, number, number];
  controlsRef: React.MutableRefObject<any>;
  controlProfile: CameraControlProfileId;
  onInteractionChange?: (active: boolean) => void;
}) {
  const handleStart = useCallback(() => {
    onInteractionChange?.(true);
  }, [onInteractionChange]);
  const handleEnd = useCallback(() => {
    onInteractionChange?.(false);
  }, [onInteractionChange]);
  const stepLockState = useRef(createCameraStepLockState());
  const profile = CAMERA_CONTROL_PROFILES[controlProfile];
  const handleChange = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) {
      return;
    }
    const snapped = applyCameraStepLock({
      camera: controls.object,
      controls,
      profile,
      state: stepLockState.current,
    });
    if (snapped) {
      controls.update();
    }
  }, [controlsRef, profile]);

  if (navigation === "cad") {
    return (
      <OrbitControls
        ref={controlsRef}
        enableDamping={FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableControlDamping}
        dampingFactor={
          FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableControlDamping ? profile.dampingFactor : 0
        }
        rotateSpeed={profile.rotateSpeed}
        zoomSpeed={profile.zoomSpeed}
        panSpeed={profile.panSpeed}
        screenSpacePanning
        target={target}
        onStart={handleStart}
        onEnd={handleEnd}
        onChange={handleChange}
      />
    );
  }

  return (
    <TrackballControls
      ref={controlsRef}
      rotateSpeed={profile.rotateSpeed}
      zoomSpeed={profile.zoomSpeed}
      panSpeed={profile.panSpeed}
      dynamicDampingFactor={profile.dampingFactor}
      target={target}
      onChange={handleChange}
      onStart={handleStart}
      onEnd={handleEnd}
    />
  );
}

function ShellBridgeSync({
  bridgeRef,
  controlsRef,
  awaitControls,
}: {
  bridgeRef: MutableRefObject<any> | null;
  controlsRef: MutableRefObject<any>;
  awaitControls: boolean;
}) {
  const { camera } = useThree();

  useEffect(() => {
    if (!bridgeRef) {
      return;
    }

    let raf = 0;
    let disposed = false;

    const syncBridge = () => {
      if (disposed) {
        return;
      }
      const controls = controlsRef.current ?? null;
      bridgeRef.current = { camera, controls };
      if (awaitControls && !controls) {
        raf = window.requestAnimationFrame(syncBridge);
      }
    };

    syncBridge();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
      bridgeRef.current = null;
    };
  }, [awaitControls, bridgeRef, camera, controlsRef]);

  return null;
}

export default function ScientificViewportShell({
  children,
  toolbar,
  hud,
  gizmos,
  backgroundColor = 0x1e1e2e,
  projection = "perspective",
  navigation = "trackball",
  qualityProfile = "interactive",
  target = DEFAULT_SHELL_TARGET,
  onViewCubeRotate,
  onResetView,
  showOrientationSphere = false,
  orientationSphereAxisConvention = "identity",
  orientationSpherePositionClassName,
  bridgeRef = null,
  controlsRef: externalControlsRef = null,
  onCanvasCreated,
  onPointerMissed,
  onCanvasContextMenu,
  renderDefaultGizmos = true,
  renderPolicy,
  onInteractionChange,
  controlProfile = "fdm",
  diagnosticOverrides,
  telemetryLabel = "scientific-viewport",
}: ScientificViewportShellProps) {
  const controlsEnabled =
    diagnosticOverrides?.enableControls ?? FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableViewportControls;
  const lightsEnabled =
    diagnosticOverrides?.enableLights ?? FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableViewportLights;
  const pointerMissedEnabled =
    diagnosticOverrides?.enableCanvasPointerMissedHandler ??
    FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableCanvasPointerMissedHandler;
  const contextMenuEnabled =
    diagnosticOverrides?.enableCanvasContextMenuHandler ??
    FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableCanvasContextMenuHandler;
  const canvasCreatedEnabled =
    diagnosticOverrides?.enableCanvasCreatedHandler ??
    FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableCanvasCreatedHandler;
  const bridgeSyncEnabled =
    diagnosticOverrides?.enableBridgeSync ?? FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableBridgeSync;
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("ScientificViewportShell", {
      bareCanvas: FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell,
      controls: controlsEnabled,
      lights: lightsEnabled,
    });
  }
  const internalBridgeRef = useRef<any>(null);
  const internalControlsRef = useRef<any>(null);
  const effectiveBridgeRef = bridgeRef ?? internalBridgeRef;
  const effectiveControlsRef = externalControlsRef ?? internalControlsRef;
  const { hostRef, hostNode } = useCanvasHost<HTMLDivElement>();
  const profile = getViewportQualityProfile(qualityProfile);
  const interactionActiveRef = useRef(false);
  const resolvedRenderMode = renderPolicy?.mode ?? "demand";
  const resolvedHidden = renderPolicy?.hidden ?? false;
  const forcedFrameloopMode = String(
    diagnosticOverrides?.forceFrameloopMode ?? FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.frameloopMode,
  ) as ViewportFrameloopMode;
  const frameloop: ViewportFrameloopMode =
    resolvedHidden || resolvedRenderMode === "paused"
      ? "never"
      : forcedFrameloopMode === "always" || resolvedRenderMode === "always"
        ? "always"
        : forcedFrameloopMode === "never"
          ? "never"
          : "demand";
  const telemetry = useViewportTelemetryEntry({
    label: telemetryLabel,
    renderer: "webgl",
    frameloop,
    hidden: resolvedHidden,
  });
  const handleInteractionChange = useCallback((next: boolean) => {
    if (interactionActiveRef.current === next) {
      return;
    }
    interactionActiveRef.current = next;
    onInteractionChange?.(next);
  }, [onInteractionChange]);

  const glOptions = useMemo(
    () => ({
      antialias: profile.antialias,
      preserveDrawingBuffer: profile.preserveDrawingBuffer,
      localClippingEnabled: true,
    }),
    [profile.antialias, profile.preserveDrawingBuffer],
  );
  const effectiveDpr = FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.forceDpr ?? Math.min(
    typeof window !== "undefined" ? window.devicePixelRatio : 1,
    profile.dprCap,
  );
  const renderShellCanvas = (useHostEventSource: boolean) => (
    <Canvas
      {...(useHostEventSource && hostNode ? { eventSource: hostNode } : {})}
      frameloop={frameloop}
      gl={glOptions}
      dpr={effectiveDpr}
      onPointerMissed={pointerMissedEnabled ? onPointerMissed : undefined}
      onContextMenu={
        contextMenuEnabled ? onCanvasContextMenu : undefined
      }
      onCreated={({ gl, camera }) => {
        if (profile.toneMapping === "aces") {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        } else {
          gl.toneMapping = THREE.NoToneMapping;
        }
        const controls = effectiveControlsRef.current;
        if (bridgeSyncEnabled && effectiveBridgeRef) {
          effectiveBridgeRef.current = { camera, controls };
        }
        if (canvasCreatedEnabled) {
          onCanvasCreated?.({ gl, camera });
        }
      }}
    >
      <ShellCamera projection={projection} />
      <color attach="background" args={[backgroundColor]} />
      {lightsEnabled ? (
        <>
          <ambientLight intensity={0.32} />
          <directionalLight position={[1.5, 2.5, 3.5]} intensity={1.0} />
          <directionalLight position={[-1.2, -1.4, -2.5]} intensity={0.28} />
          <hemisphereLight intensity={0.24} />
        </>
      ) : null}
      {children}
      {controlsEnabled ? (
        <ShellControls
          navigation={navigation}
          target={target}
          controlsRef={effectiveControlsRef}
          controlProfile={controlProfile}
          onInteractionChange={handleInteractionChange}
        />
      ) : null}
      {bridgeSyncEnabled ? (
        <ShellBridgeSync
          bridgeRef={effectiveBridgeRef}
          controlsRef={effectiveControlsRef}
          awaitControls={controlsEnabled}
        />
      ) : null}
      <ViewportTelemetryProbe
        dpr={effectiveDpr}
        hidden={resolvedHidden}
        onStats={telemetry.update}
      />
    </Canvas>
  );

  return (
    <div ref={hostRef} className="relative flex h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md bg-background">
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell
        ? renderShellCanvas(false)
        : hostNode
          ? renderShellCanvas(FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useCanvasHostEventSource)
          : null}

      {toolbar}
      {hud}
      {gizmos ?? (renderDefaultGizmos && !FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell ? (
        <ViewportGizmoStack
          sceneRef={effectiveBridgeRef}
          onRotate={onViewCubeRotate}
          onReset={onResetView}
          showOrientationSphere={showOrientationSphere}
          orientationSphereAxisConvention={orientationSphereAxisConvention}
          orientationSpherePositionClassName={orientationSpherePositionClassName}
        />
      ) : null)}
    </div>
  );
}
