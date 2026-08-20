"use client";

import {
  createRoot,
  extend,
  unmountComponentAtNode,
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
  const configureGenerationRef = useRef(0);
  const latestPointerMissedRef = useRef(onPointerMissed);
  const latestCreatedRef = useRef(onCreated);
  const latestSceneRef = useRef<React.ReactNode>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [size, setSize] = useState<Viewport3DCanvasSize | null>(null);
  const sceneContent = useMemo(
    () => (
      <Viewport3DCanvasErrorBridge onError={setError}>
        <React.Suspense fallback={fallback ?? null}>{children}</React.Suspense>
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
    rootRef.current = root;
    const configureGeneration = configureGenerationRef.current + 1;
    configureGenerationRef.current = configureGeneration;
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
          const eventTarget = eventSource
            ? "current" in eventSource
              ? eventSource.current
              : eventSource
            : container;
          state.events.connect?.(eventTarget);
          recordVisualizationDebugCanvasLifecycle("events-connected");
          recordVisualizationDebugCanvasLifecycle("context-created");
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
        if (configureGenerationRef.current !== configureGeneration) return;
        rootConfiguredRef.current = true;
        recordVisualizationDebugCanvasLifecycle("root-configure-completed");
        configuredRoot.render(latestSceneRef.current);
      })
      .catch(setError);
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
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        recordVisualizationDebugCanvasLifecycle("events-disconnected");
        recordVisualizationDebugCanvasLifecycle("context-disposed");
        unmountComponentAtNode(canvas);
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
