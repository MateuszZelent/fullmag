"use client";

import { createRoot, extend, type CanvasProps, type RootState } from "@react-three/fiber";
import * as React from "react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AmbientLight,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  PerspectiveCamera,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
} from "three";

import { recordVisualizationDebugCanvasLifecycle } from "@/kernel/performance/visualizationDebugPerformanceProbe";
import { Viewport3DInvalidationProvider } from "./viewport3dBatchedInvalidate";
import { type Viewport3DCanvasSize, createViewport3DCanvasLifecycleController, sanitizeViewport3DCanvasMeasure } from "./Viewport3DCanvas.model";

type Viewport3DCanvasProps = Omit<CanvasProps, "resize" | "size">;

extend({
  AmbientLight,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  PerspectiveCamera,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
});

function sameViewport3DCanvasSize(
  previous: Viewport3DCanvasSize | null,
  next: Viewport3DCanvasSize,
): boolean {
  return (
    previous?.height === next.height &&
    previous.left === next.left &&
    previous.top === next.top &&
    previous.width === next.width
  );
}

function Viewport3DCanvasErrorBridge({
  children,
  onError,
}: {
  children: React.ReactNode;
  onError: (error: unknown) => void;
}) {
  return (
    <Viewport3DCanvasErrorBoundary onError={onError}>
      {children}
    </Viewport3DCanvasErrorBoundary>
  );
}

class Viewport3DCanvasErrorBoundary extends React.Component<
  { children: React.ReactNode; onError: (error: unknown) => void },
  { error: unknown | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

export const Viewport3DCanvas = forwardRef<
  HTMLCanvasElement,
  Viewport3DCanvasProps
>(function Viewport3DCanvas(
  {
    camera,
    children,
    className,
    dpr,
    eventPrefix,
    eventSource,
    events,
    fallback,
    flat,
    frameloop,
    gl,
    legacy,
    linear,
    onContextMenu,
    onCreated,
    onPointerMissed,
    orthographic,
    performance,
    raycaster,
    scene,
    shadows,
    style,
    ...divProps
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<ReturnType<typeof createRoot<HTMLCanvasElement>> | null>(
    null,
  );
  const rootConfiguredRef = useRef(false);
  const [lifecycle] = useState(() => createViewport3DCanvasLifecycleController());
  const rootStateRef = useRef<RootState | null>(null);
  const latestPointerMissedRef = useRef(onPointerMissed);
  const latestCreatedRef = useRef(onCreated);
  const latestSceneRef = useRef<React.ReactNode>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [size, setSize] = useState<Viewport3DCanvasSize | null>(null);
  const sceneContent = useMemo(
    () => (
      <Viewport3DCanvasErrorBridge onError={setError}>
        <React.Suspense fallback={fallback ?? null}>
          <Viewport3DInvalidationProvider>
            {children}
          </Viewport3DInvalidationProvider>
        </React.Suspense>
      </Viewport3DCanvasErrorBridge>
    ),
    [children, fallback],
  );

  useImperativeHandle(ref, () => canvasRef.current as HTMLCanvasElement, []);

  useEffect(() => {
    latestPointerMissedRef.current = onPointerMissed;
  }, [onPointerMissed]);

  useEffect(() => {
    latestCreatedRef.current = onCreated;
  }, [onCreated]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const measure = () => {
      const next = sanitizeViewport3DCanvasMeasure(
        container.getBoundingClientRect(),
      );
      setSize((previous) =>
        sameViewport3DCanvasSize(previous, next) ? previous : next,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    latestSceneRef.current = sceneContent;
    if (!rootConfiguredRef.current) return;
    rootRef.current?.render(sceneContent);
  }, [sceneContent]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !size || size.width <= 0 || size.height <= 0) {
      return;
    }

    const root = rootRef.current ?? createRoot(canvas);
    if (!rootRef.current) {
      lifecycle.mountRoot();
      rootRef.current = root;
    }
    const configureGeneration = lifecycle.startConfigure();
    recordVisualizationDebugCanvasLifecycle("root-configure-started");

    void root
      .configure({
        camera,
        dpr,
        events,
        flat,
        frameloop,
        gl,
        legacy,
        linear,
        onCreated: (state: RootState) => {
          rootStateRef.current = state;
          const eventTarget = eventSource
            ? "current" in eventSource
              ? eventSource.current
              : eventSource
            : container;
          if (lifecycle.eventsConnected()) {
            state.events.connect?.(eventTarget);
            recordVisualizationDebugCanvasLifecycle("events-connected");
          }
          if (lifecycle.contextCreated()) {
            recordVisualizationDebugCanvasLifecycle("context-created");
          }
          if (eventPrefix) {
            state.setEvents({
              compute: (event, rootState) => {
                const pointerEvent = event as MouseEvent &
                  Record<string, number | undefined>;
                const x = pointerEvent[`${eventPrefix}X`] ?? 0;
                const y = pointerEvent[`${eventPrefix}Y`] ?? 0;
                rootState.pointer.set(
                  (x / rootState.size.width) * 2 - 1,
                  -(y / rootState.size.height) * 2 + 1,
                );
                rootState.raycaster.setFromCamera(
                  rootState.pointer,
                  rootState.camera,
                );
              },
            });
          }
          latestCreatedRef.current?.(state);
        },
        onPointerMissed: (event) =>
          latestPointerMissedRef.current?.(event),
        orthographic,
        performance,
        raycaster,
        scene,
        shadows,
        size,
      })
      .then((configuredRoot) => {
        if (!lifecycle.configureCompleted(configureGeneration)) return;
        rootConfiguredRef.current = true;
        recordVisualizationDebugCanvasLifecycle("root-configure-completed");
        configuredRoot.render(latestSceneRef.current);
      })
      .catch((configureError: unknown) => {
        if (lifecycle.isCurrentConfigure(configureGeneration)) {
          setError(configureError);
        }
      });
  }, [
    camera,
    dpr,
    eventPrefix,
    eventSource,
    events,
    flat,
    frameloop,
    gl,
    lifecycle,
    legacy,
    linear,
    orthographic,
    performance,
    raycaster,
    scene,
    shadows,
    size,
  ]);

  useEffect(() => {
    return () => {
      const teardown = lifecycle.unmountRoot();
      const rootState = rootStateRef.current;
      rootState?.events.disconnect?.();
      // three.js shares one module-level BufferGeometry between all Sprites;
      // every renderer that drew it adds a `dispose` listener which closes over
      // its WebGL context. Neither WebGLRenderer.dispose() nor the R3F teardown
      // removes it, so each unmounted viewport stayed reachable. Disposing the
      // shared geometry lets every renderer release its listener; live
      // renderers upload it again on their next frame.
      releaseSharedSpriteGeometries(rootState?.scene);
      rootStateRef.current = null;
      // Closures handed to the R3F store (onPointerMissed, configure().then)
      // keep these refs alive with the last scene element and its buffers.
      latestSceneRef.current = null;
      latestPointerMissedRef.current = undefined;
      latestCreatedRef.current = undefined;
      rootRef.current?.unmount();
      if (teardown.disconnectEvents) {
        recordVisualizationDebugCanvasLifecycle("events-disconnected");
      }
      if (teardown.disposeContext) {
        recordVisualizationDebugCanvasLifecycle("context-disposed");
      }
      rootConfiguredRef.current = false;
      rootRef.current = null;
    };
  }, [lifecycle]);

  if (error) throw error;

  return (
    <div
      {...divProps}
      className={className}
      onContextMenu={onContextMenu}
      style={{
        height: "100%",
        overflow: "hidden",
        pointerEvents: eventSource ? "none" : "auto",
        position: "relative",
        width: "100%",
        ...style,
      }}
    >
      <div ref={containerRef} style={{ height: "100%", width: "100%" }}>
        <canvas ref={canvasRef} style={{ display: "block" }}>
          {fallback}
        </canvas>
      </div>
    </div>
  );
});

function releaseSharedSpriteGeometries(scene: { traverse: (visit: (object: unknown) => void) => void } | undefined): void {
  if (!scene) return;
  const geometries = new Set<{ dispose: () => void }>();
  scene.traverse((object) => {
    const sprite = object as { isSprite?: boolean; geometry?: { dispose: () => void } };
    if (sprite.isSprite && sprite.geometry) geometries.add(sprite.geometry);
  });
  geometries.forEach((geometry) => geometry.dispose());
}
