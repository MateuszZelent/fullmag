import { type Size } from "@react-three/fiber";

export type Viewport3DCanvasSize = Pick<Size, "height" | "left" | "top" | "width">;

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
