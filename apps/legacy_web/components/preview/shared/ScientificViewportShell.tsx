"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
import { useViewportSceneBridgeSync } from "./useViewportSceneBridgeSync";
import {
  incrementFrontendAuditCounter,
  recordFrontendAuditWebGLContext,
  setFrontendAuditCounter,
} from "@/lib/debug/frontendAudit";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { useViewportTelemetryEntry } from "@/lib/debug/viewportTelemetry";
import {
  shouldRenderCanvasVisualActivityProbe,
  shouldRenderViewportWebglCanvas,
} from "./viewportWebglCanvasPolicy";
import {
  resolveViewportFrameloop,
  type ViewportFrameloopMode,
} from "./viewportFrameloopPolicy";
import {
  CONTEXT_LOSS_RETRY_WINDOW_MS,
} from "./viewportContextLossPolicy";
import { useViewportContextLossRecovery } from "./useViewportContextLossRecovery";

export type ShellProjection = "perspective" | "orthographic";
export type ShellNavigation = "trackball" | "cad";

const DEFAULT_SHELL_TARGET: [number, number, number] = [0, 0, 0];
export { shouldRenderCanvasVisualActivityProbe, shouldRenderViewportWebglCanvas };

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
  onVisualActivityChange?: (active: boolean) => void;
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

const VISUAL_ACTIVITY_SAMPLE_POINTS = [
  [0.18, 0.22], [0.38, 0.22], [0.58, 0.22], [0.78, 0.22],
  [0.22, 0.42], [0.42, 0.42], [0.62, 0.42], [0.82, 0.42],
  [0.18, 0.62], [0.38, 0.62], [0.58, 0.62], [0.78, 0.62],
  [0.28, 0.78], [0.5, 0.78], [0.72, 0.78],
] as const;

function backgroundRgb(color: number): [number, number, number] {
  return [
    (color >> 16) & 255,
    (color >> 8) & 255,
    color & 255,
  ];
}

function CanvasVisualActivityProbe({
  backgroundColor,
  onVisualActivityChange,
}: {
  backgroundColor: number;
  onVisualActivityChange?: (active: boolean) => void;
}) {
  const { gl } = useThree();
  const lastActiveRef = useRef<boolean | null>(null);
  const sampleScheduledRef = useRef(false);
  const frameCounterRef = useRef(0);
  const pixelBufRef = useRef<Uint8Array | null>(null);
  const background = useMemo(() => backgroundRgb(backgroundColor), [backgroundColor]);

  useFrame(() => {
    if (!onVisualActivityChange) {
      return;
    }
    // Throttle: only probe every 30th frame to avoid GPU→CPU readPixels stall
    frameCounterRef.current += 1;
    if (frameCounterRef.current < 30) {
      return;
    }
    frameCounterRef.current = 0;
    if (sampleScheduledRef.current) {
      return;
    }
    sampleScheduledRef.current = true;
    window.setTimeout(() => {
      sampleScheduledRef.current = false;
      const context = gl.getContext();
      const width = context.drawingBufferWidth;
      const height = context.drawingBufferHeight;
      if (width <= 0 || height <= 0) {
        if (lastActiveRef.current !== false) {
          lastActiveRef.current = false;
          onVisualActivityChange(false);
        }
        return;
      }
      if (!pixelBufRef.current) {
        pixelBufRef.current = new Uint8Array(4);
      }
      const pixel = pixelBufRef.current;
      let activeSamples = 0;
      try {
        for (const [xFactor, yFactor] of VISUAL_ACTIVITY_SAMPLE_POINTS) {
          const x = Math.max(0, Math.min(width - 1, Math.round(width * xFactor)));
          const y = Math.max(0, Math.min(height - 1, Math.round(height * yFactor)));
          context.readPixels(x, y, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
          const delta =
            Math.abs(pixel[0] - background[0]) +
            Math.abs(pixel[1] - background[1]) +
            Math.abs(pixel[2] - background[2]);
          if (delta > 36 && pixel[3] > 0) {
            activeSamples += 1;
          }
        }
      } catch {
        if (lastActiveRef.current !== false) {
          lastActiveRef.current = false;
          onVisualActivityChange(false);
        }
        return;
      }
      const active = activeSamples > 0 || gl.info.render.calls > 0;
      if (lastActiveRef.current !== active) {
        lastActiveRef.current = active;
        onVisualActivityChange(active);
      }
    }, 0);
  });

  return null;
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

/** P-25: Fires invalidate() when a warm-hidden canvas transitions back to visible.
 * Without this, switching to a warm-hidden tab changes frameloop from "never" to "demand"
 * but no draw call is dispatched until the next user interaction or data update, leaving
 * the viewport blank/black for an observable instant.
 */
function WarmHideRevealInvalidator({ hidden }: { hidden: boolean }) {
  const { invalidate } = useThree();
  const prevHiddenRef = useRef(hidden);
  useEffect(() => {
    const wasHidden = prevHiddenRef.current;
    prevHiddenRef.current = hidden;
    if (wasHidden && !hidden) {
      invalidate();
    }
  }, [hidden, invalidate]);
  return null;
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
  useViewportSceneBridgeSync({ bridgeRef, controlsRef, camera, awaitControls });
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
  onVisualActivityChange,
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
  const [canvasContextGeneration, setCanvasContextGeneration] = useState(0);
  const resolvedRenderMode = renderPolicy?.mode ?? "demand";
  const resolvedHidden = renderPolicy?.hidden ?? false;
  const forcedFrameloopMode = String(
    diagnosticOverrides?.forceFrameloopMode ?? FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.frameloopMode,
  ) as ViewportFrameloopMode;
  const frameloop = resolveViewportFrameloop({
    hidden: resolvedHidden,
    renderMode: resolvedRenderMode,
    forcedFrameloopMode,
  });
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

  const remountWebglViewport = useCallback(() => {
    setCanvasContextGeneration((generation) => generation + 1);
  }, []);
  const {
    contextLossBlocked,
    retryWebglViewport,
    handleContextLost,
    handleContextRestored,
    clearRetryTimer: clearContextLossRetryTimer,
  } = useViewportContextLossRecovery({
    hidden: resolvedHidden,
    onRemount: remountWebglViewport,
    onContextLost: () => {
      telemetry.recordLifecycleEvent("context_lost");
    },
    onHiddenContextLost: () => {
      console.warn("[viewport-webgl] hidden context lost; hidden WebGL tabs should be active-only", {
        telemetryLabel,
        generation: canvasContextGeneration,
      });
    },
    onRecoveryBlocked: (decision) => {
      console.error("[viewport-webgl] context lost; automatic remount blocked after repeated failures", {
        telemetryLabel,
        generation: canvasContextGeneration,
        retryCount: decision.nextTimestamps.length,
        retryWindowMs: CONTEXT_LOSS_RETRY_WINDOW_MS,
      });
    },
    onRecoveryScheduled: (decision) => {
      console.warn("[viewport-webgl] context lost; scheduling canvas remount", {
        telemetryLabel,
        generation: canvasContextGeneration,
        retryDelayMs: decision.retryDelayMs,
      });
    },
    onContextRestored: () => {
      telemetry.recordLifecycleEvent("context_restored");
      if (
        FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryRenderLogging &&
        FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace
      ) {
        writeFrontendDiagnosticConsole("info", "[viewport-webgl] context restored", {
          telemetryLabel,
          generation: canvasContextGeneration,
        });
      }
    },
  });

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
  const shouldRenderCanvas = shouldRenderViewportWebglCanvas({
    hidden: resolvedHidden,
    hostReady: Boolean(hostNode),
    bareCanvas: FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell,
  });
  const shouldRenderVisualActivityProbe = shouldRenderCanvasVisualActivityProbe({
    enabled: FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.enableCanvasVisualActivityProbe,
    hasCallback: Boolean(onVisualActivityChange),
  });

  useEffect(() => {
    setFrontendAuditCounter("webglCanvasHidden", resolvedHidden && shouldRenderCanvas ? 1 : 0);
  }, [resolvedHidden, shouldRenderCanvas]);

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
        telemetry.recordLifecycleEvent("canvas_mount");
        incrementFrontendAuditCounter("webglCanvasMounted", 1);
        recordFrontendAuditWebGLContext(telemetryLabel, gl.getContext());
        if (
          FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryRenderLogging &&
          FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace
        ) {
          writeFrontendDiagnosticConsole("info", "[viewport-webgl] canvas created", {
            telemetryLabel,
            generation: canvasContextGeneration,
            drawingBuffer: {
              width: gl.getContext().drawingBufferWidth,
              height: gl.getContext().drawingBufferHeight,
            },
          });
        }
        canvas.addEventListener("webglcontextlost", handleContextLost, false);
        canvas.addEventListener("webglcontextrestored", handleContextRestored, false);
        canvasContextCleanupRef.current = () => {
          telemetry.recordLifecycleEvent("canvas_unmount");
          clearContextLossRetryTimer();
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
      <WarmHideRevealInvalidator hidden={resolvedHidden} />
      <ViewportTelemetryProbe
        label={telemetryLabel}
        dpr={effectiveDpr}
        hidden={resolvedHidden}
        onStats={telemetry.update}
      />
      {shouldRenderVisualActivityProbe ? (
        <CanvasVisualActivityProbe
          backgroundColor={backgroundColor}
          onVisualActivityChange={onVisualActivityChange}
        />
      ) : null}
    </Canvas>
  );

  useEffect(() => {
    return () => {
      canvasContextCleanupRef.current?.();
      canvasContextCleanupRef.current = null;
      clearContextLossRetryTimer();
    };
  }, [clearContextLossRetryTimer]);

  return (
    <div ref={hostRef} className="relative flex h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md bg-background">
      {shouldRenderCanvas && FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.useBareCanvasShell
        ? renderShellCanvas(false)
        : shouldRenderCanvas && hostNode
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
