"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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
import { disableWebGLWarmKeepAliveForSession } from "@/lib/viewport/webglWarmKeepAliveGuard";
import { useViewportTelemetryEntry } from "@/lib/debug/viewportTelemetry";

export type ShellProjection = "perspective" | "orthographic";
export type ShellNavigation = "trackball" | "cad";
export type ViewportFrameloopMode = "always" | "demand" | "never";

const DEFAULT_SHELL_TARGET: [number, number, number] = [0, 0, 0];
export const CONTEXT_LOSS_RETRY_WINDOW_MS = 30_000;
export const CONTEXT_LOSS_MAX_RETRIES = 2;
export const CONTEXT_LOSS_RETRY_DELAY_MS = 250;

export interface ContextLossRecoveryDecision {
  allowed: boolean;
  nextTimestamps: number[];
  retryDelayMs: number;
}

export function resolveContextLossRecovery({
  nowMs,
  retryTimestamps,
  retryWindowMs = CONTEXT_LOSS_RETRY_WINDOW_MS,
  maxRetries = CONTEXT_LOSS_MAX_RETRIES,
  retryDelayMs = CONTEXT_LOSS_RETRY_DELAY_MS,
}: {
  nowMs: number;
  retryTimestamps: readonly number[];
  retryWindowMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}): ContextLossRecoveryDecision {
  const windowStart = nowMs - retryWindowMs;
  const recentTimestamps = retryTimestamps.filter((timestamp) => timestamp >= windowStart);
  if (recentTimestamps.length >= maxRetries) {
    return {
      allowed: false,
      nextTimestamps: recentTimestamps,
      retryDelayMs: 0,
    };
  }
  const nextTimestamps = [...recentTimestamps, nowMs];
  return {
    allowed: true,
    nextTimestamps,
    retryDelayMs: retryDelayMs * nextTimestamps.length,
  };
}

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
  enabled,
  onInteractionChange,
}: {
  navigation: ShellNavigation;
  target: [number, number, number];
  controlsRef: React.MutableRefObject<any>;
  controlProfile: CameraControlProfileId;
  enabled: boolean;
  onInteractionChange?: (active: boolean) => void;
}) {
  const handleStart = useCallback(() => {
    onInteractionChange?.(true);
  }, [onInteractionChange]);
  const handleEnd = useCallback(() => {
    onInteractionChange?.(false);
  }, [onInteractionChange]);
  const stepLockState = useRef(createCameraStepLockState());
  const stepLockSyncingRef = useRef(false);
  const profile = CAMERA_CONTROL_PROFILES[controlProfile];
  const handleChange = useCallback(() => {
    if (stepLockSyncingRef.current) {
      return;
    }
    if (navigation !== "cad") {
      return;
    }
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
      stepLockSyncingRef.current = true;
      try {
        controls.update();
      } finally {
        stepLockSyncingRef.current = false;
      }
    }
  }, [controlsRef, navigation, profile]);

  if (navigation === "cad") {
    return (
      <OrbitControls
        ref={controlsRef}
        enabled={enabled}
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
      enabled={enabled}
      staticMoving
      dynamicDampingFactor={0}
      rotateSpeed={profile.rotateSpeed}
      zoomSpeed={profile.zoomSpeed}
      panSpeed={profile.panSpeed}
      target={target}
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
  const canvasContextCleanupRef = useRef<(() => void) | null>(null);
  const contextLossRetryTimestampsRef = useRef<number[]>([]);
  const contextLossRetryTimerRef = useRef<number | null>(null);
  const [canvasContextGeneration, setCanvasContextGeneration] = useState(0);
  const [contextLossBlocked, setContextLossBlocked] = useState(false);
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

  const retryWebglViewport = useCallback(() => {
    if (contextLossRetryTimerRef.current !== null) {
      window.clearTimeout(contextLossRetryTimerRef.current);
      contextLossRetryTimerRef.current = null;
    }
    contextLossRetryTimestampsRef.current = [];
    setContextLossBlocked(false);
    setCanvasContextGeneration((generation) => generation + 1);
  }, []);

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
      key={canvasContextGeneration}
      {...(useHostEventSource && hostNode ? { eventSource: hostNode } : {})}
      frameloop={frameloop}
      gl={glOptions}
      dpr={effectiveDpr}
      onPointerMissed={pointerMissedEnabled ? onPointerMissed : undefined}
      onContextMenu={
        contextMenuEnabled ? onCanvasContextMenu : undefined
      }
      onCreated={({ gl, camera }) => {
        canvasContextCleanupRef.current?.();
        const canvas = gl.domElement;
        if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryRenderLogging) {
          console.info("[viewport-webgl] canvas created", {
            telemetryLabel,
            generation: canvasContextGeneration,
            drawingBuffer: {
              width: gl.getContext().drawingBufferWidth,
              height: gl.getContext().drawingBufferHeight,
            },
          });
        }
        const handleContextLost = (event: Event) => {
          event.preventDefault();
          if (resolvedHidden) {
            disableWebGLWarmKeepAliveForSession();
            console.warn("[viewport-webgl] hidden context lost; disabling WebGL warm keepalive", {
              telemetryLabel,
              generation: canvasContextGeneration,
            });
            return;
          }
          const decision = resolveContextLossRecovery({
            nowMs: Date.now(),
            retryTimestamps: contextLossRetryTimestampsRef.current,
          });
          contextLossRetryTimestampsRef.current = decision.nextTimestamps;
          if (!decision.allowed) {
            setContextLossBlocked(true);
            console.error("[viewport-webgl] context lost; automatic remount blocked after repeated failures", {
              telemetryLabel,
              generation: canvasContextGeneration,
              retryCount: decision.nextTimestamps.length,
              retryWindowMs: CONTEXT_LOSS_RETRY_WINDOW_MS,
            });
            return;
          }
          setContextLossBlocked(false);
          if (contextLossRetryTimerRef.current !== null) {
            return;
          }
          console.warn("[viewport-webgl] context lost; scheduling canvas remount", {
            telemetryLabel,
            generation: canvasContextGeneration,
            retryDelayMs: decision.retryDelayMs,
          });
          contextLossRetryTimerRef.current = window.setTimeout(() => {
            contextLossRetryTimerRef.current = null;
            setCanvasContextGeneration((generation) => generation + 1);
          }, decision.retryDelayMs);
        };
        const handleContextRestored = () => {
          setContextLossBlocked(false);
          if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryRenderLogging) {
            console.info("[viewport-webgl] context restored", {
              telemetryLabel,
              generation: canvasContextGeneration,
            });
          }
        };
        canvas.addEventListener("webglcontextlost", handleContextLost, false);
        canvas.addEventListener("webglcontextrestored", handleContextRestored, false);
        canvasContextCleanupRef.current = () => {
          canvas.removeEventListener("webglcontextlost", handleContextLost, false);
          canvas.removeEventListener("webglcontextrestored", handleContextRestored, false);
        };
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
      <ShellControls
        navigation={navigation}
        target={target}
        controlsRef={effectiveControlsRef}
        controlProfile={controlProfile}
        enabled={controlsEnabled && !resolvedHidden}
        onInteractionChange={handleInteractionChange}
      />
      {bridgeSyncEnabled ? (
        <ShellBridgeSync
          bridgeRef={effectiveBridgeRef}
          controlsRef={effectiveControlsRef}
          awaitControls
        />
      ) : null}
      <ViewportTelemetryProbe
        label={telemetryLabel}
        dpr={effectiveDpr}
        hidden={resolvedHidden}
        onStats={telemetry.update}
      />
    </Canvas>
  );

  useEffect(() => {
    return () => {
      canvasContextCleanupRef.current?.();
      canvasContextCleanupRef.current = null;
      if (contextLossRetryTimerRef.current !== null) {
        window.clearTimeout(contextLossRetryTimerRef.current);
        contextLossRetryTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={hostRef} className="relative flex h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md bg-background">
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell
        ? renderShellCanvas(false)
        : hostNode
          ? renderShellCanvas(FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useCanvasHostEventSource)
          : null}

      {toolbar}
      {hud}
      {contextLossBlocked ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85 px-6 text-center backdrop-blur-sm">
          <div className="max-w-sm rounded-md border border-border bg-card p-4 shadow-lg">
            <div className="text-sm font-semibold text-foreground">WebGL viewport paused</div>
            <div className="mt-2 text-xs leading-5 text-muted-foreground">
              The browser lost the WebGL context repeatedly. Automatic remounts were stopped to avoid a recovery loop.
            </div>
            <button
              type="button"
              className="mt-4 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
              onClick={retryWebglViewport}
            >
              Retry viewport
            </button>
          </div>
        </div>
      ) : null}
      {resolvedHidden ? null : gizmos ?? (renderDefaultGizmos && !FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell ? (
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
