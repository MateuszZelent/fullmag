"use client";

import {
  createRoot,
  extend,
  type CanvasProps,
  type Catalogue,
  type RootState,
  type Size,
} from "@react-three/fiber";
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
import * as THREE from "three";

import { recordVisualizationDebugCanvasLifecycle } from "@/kernel/performance/visualizationDebugPerformanceProbe";
import { Viewport3DInvalidationProvider } from "./viewport3dBatchedInvalidate";

type Viewport3DCanvasProps = Omit<CanvasProps, "resize" | "size">;

type Viewport3DCanvasSize = Pick<Size, "height" | "left" | "top" | "width">;

export function sanitizeViewport3DCanvasMeasure(
  rect: Pick<DOMRectReadOnly, "height" | "width">,
): Viewport3DCanvasSize {
  return {
    height: rect.height,
    left: 0,
    top: 0,
    width: rect.width,
  };
}

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

export interface Viewport3DCanvasLifecycleSnapshot {
  activeRoots: number;
  configureCompleted: number;
  configureStarted: number;
  contextCreated: number;
  contextDisposed: number;
  eventConnections: number;
  eventDisconnections: number;
  rootsCreated: number;
  rootsUnmounted: number;
}

export function createViewport3DCanvasLifecycleController() {
  let activeRoot = false;
  let configureGeneration = 0;
  let contextActive = false;
  let eventsConnected = false;
  const snapshot: Viewport3DCanvasLifecycleSnapshot = {
    activeRoots: 0,
    configureCompleted: 0,
    configureStarted: 0,
    contextCreated: 0,
    contextDisposed: 0,
    eventConnections: 0,
    eventDisconnections: 0,
    rootsCreated: 0,
    rootsUnmounted: 0,
  };

  return {
    configureCompleted(generation: number): boolean {
      if (generation !== configureGeneration || !activeRoot) return false;
      snapshot.configureCompleted += 1;
      return true;
    },
    contextCreated(): boolean {
      if (contextActive) return false;
      contextActive = true;
      snapshot.contextCreated += 1;
      return true;
    },
    eventsConnected(): boolean {
      if (eventsConnected) return false;
      eventsConnected = true;
      snapshot.eventConnections += 1;
      return true;
    },
    getSnapshot(): Viewport3DCanvasLifecycleSnapshot {
      return { ...snapshot };
    },
    isCurrentConfigure(generation: number): boolean {
      return activeRoot && generation === configureGeneration;
    },
    mountRoot(): void {
      if (activeRoot) {
        throw new Error("Viewport3DCanvas root is already active");
      }
      activeRoot = true;
      snapshot.activeRoots = 1;
      snapshot.rootsCreated += 1;
    },
    startConfigure(): number {
      if (!activeRoot) {
        throw new Error("Viewport3DCanvas root must mount before configure");
      }
      configureGeneration += 1;
      snapshot.configureStarted += 1;
      return configureGeneration;
    },
    unmountRoot(): { disposeContext: boolean; disconnectEvents: boolean } {
      if (!activeRoot) {
        return { disconnectEvents: false, disposeContext: false };
      }
      activeRoot = false;
      configureGeneration += 1;
      snapshot.activeRoots = 0;
      snapshot.rootsUnmounted += 1;
      const disconnectEvents = eventsConnected;
      const disposeContext = contextActive;
      if (disconnectEvents) {
        eventsConnected = false;
        snapshot.eventDisconnections += 1;
      }
      if (disposeContext) {
        contextActive = false;
        snapshot.contextDisposed += 1;
      }
      return { disconnectEvents, disposeContext };
    },
  };
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
  useMemo(() => extend(THREE as unknown as Catalogue), []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<ReturnType<typeof createRoot<HTMLCanvasElement>> | null>(
    null,
  );
  const rootConfiguredRef = useRef(false);
  const lifecycleRef = useRef(createViewport3DCanvasLifecycleController());
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
      lifecycleRef.current.mountRoot();
      rootRef.current = root;
    }
    const configureGeneration = lifecycleRef.current.startConfigure();
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
          if (lifecycleRef.current.eventsConnected()) {
            state.events.connect?.(eventTarget);
            recordVisualizationDebugCanvasLifecycle("events-connected");
          }
          if (lifecycleRef.current.contextCreated()) {
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
        if (!lifecycleRef.current.configureCompleted(configureGeneration)) return;
        rootConfiguredRef.current = true;
        recordVisualizationDebugCanvasLifecycle("root-configure-completed");
        configuredRoot.render(latestSceneRef.current);
      })
      .catch((configureError: unknown) => {
        if (lifecycleRef.current.isCurrentConfigure(configureGeneration)) {
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
    const lifecycle = lifecycleRef.current;
    return () => {
      const teardown = lifecycle.unmountRoot();
      rootStateRef.current?.events.disconnect?.();
      rootStateRef.current = null;
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
  }, []);

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
