"use client";

import { useSyncExternalStore } from "react";

export interface Viewport3DCameraState {
  position: [number, number, number];
  target: [number, number, number];
}

export interface Viewport3DCommandState {
  camera: Viewport3DCameraState;
  fitRevision: number;
  mockField: Viewport3DMockFieldState;
  resetCameraRevision: number;
  widgets: Viewport3DWidgetState;
}

export interface Viewport3DMockFieldState {
  /** Incrementing counter used to signal Viewport3DModule to regenerate mock data. */
  tick: number;
  /** Whether mock field animation is currently running. */
  running: boolean;
}

type Viewport3DListener = () => void;
export type Viewport3DHslReferenceMode = "auto" | "off" | "on";
export type Viewport3DCameraProjection = "perspective" | "orthographic";

export interface Viewport3DWidgetState {
  cameraProjection: Viewport3DCameraProjection;
  hslReferenceMode: Viewport3DHslReferenceMode;
  viewCubeVisible: boolean;
}

export const DEFAULT_VIEWPORT_3D_CAMERA_STATE: Viewport3DCameraState = {
  position: [2e-6, 1.4e-6, 2e-6],
  target: [0, 0, 0],
};

const DEFAULT_VIEWPORT_3D_STATE: Viewport3DCommandState = {
  camera: {
    ...DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  },
  fitRevision: 0,
  mockField: { running: false, tick: 0 },
  resetCameraRevision: 0,
  widgets: {
    cameraProjection: "perspective",
    hslReferenceMode: "auto",
    viewCubeVisible: true,
  },
};

class Viewport3DStore {
  private snapshot: Viewport3DCommandState = DEFAULT_VIEWPORT_3D_STATE;
  private readonly listeners = new Set<Viewport3DListener>();
  private mockAnimationHandle: ReturnType<typeof setInterval> | null = null;

  getSnapshot(): Viewport3DCommandState {
    return this.snapshot;
  }

  requestFit(): void {
    this.snapshot = {
      ...this.snapshot,
      fitRevision: this.snapshot.fitRevision + 1,
    };
    this.notify();
  }

  resetCamera(): void {
    this.snapshot = {
      ...this.snapshot,
      camera: DEFAULT_VIEWPORT_3D_STATE.camera,
      resetCameraRevision: this.snapshot.resetCameraRevision + 1,
    };
    this.notify();
  }

  resetForTest(): void {
    this.stopMockField();
    this.snapshot = DEFAULT_VIEWPORT_3D_STATE;
    this.notify();
  }

  /** Start mock field animation at ~8 fps. Ticks `mockField.tick` every frame. */
  startMockField(): void {
    if (this.mockAnimationHandle !== null) return;
    this.snapshot = {
      ...this.snapshot,
      mockField: { running: true, tick: this.snapshot.mockField.tick },
    };
    this.notify();
    this.mockAnimationHandle = setInterval(() => {
      this.snapshot = {
        ...this.snapshot,
        mockField: {
          running: true,
          tick: this.snapshot.mockField.tick + 1,
        },
      };
      this.notify();
    }, 125);
  }

  /** Stop mock field animation and clear mock data. */
  stopMockField(): void {
    if (this.mockAnimationHandle !== null) {
      clearInterval(this.mockAnimationHandle);
      this.mockAnimationHandle = null;
    }
    if (!this.snapshot.mockField.running) return;
    this.snapshot = {
      ...this.snapshot,
      mockField: { running: false, tick: 0 },
    };
    this.notify();
  }

  /** Toggle mock field animation on/off. */
  toggleMockField(): void {
    if (this.snapshot.mockField.running) {
      this.stopMockField();
    } else {
      this.startMockField();
    }
  }

  setHslReferenceMode(mode: Viewport3DHslReferenceMode): void {
    if (this.snapshot.widgets.hslReferenceMode === mode) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        hslReferenceMode: mode,
      },
    };
    this.notify();
  }

  setCamera(camera: Viewport3DCameraState): void {
    if (
      sameVector(this.snapshot.camera.position, camera.position) &&
      sameVector(this.snapshot.camera.target, camera.target)
    ) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      camera,
    };
    this.notify();
  }

  subscribe(listener: Viewport3DListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toggleCameraProjection(): void {
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        cameraProjection:
          this.snapshot.widgets.cameraProjection === "perspective"
            ? "orthographic"
            : "perspective",
      },
    };
    this.notify();
  }

  toggleViewCube(): void {
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        viewCubeVisible: !this.snapshot.widgets.viewCubeVisible,
      },
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const viewport3dStore = new Viewport3DStore();

export function useViewport3DCommandState(): Viewport3DCommandState {
  return useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    () => viewport3dStore.getSnapshot(),
    () => viewport3dStore.getSnapshot(),
  );
}

function sameVector(
  left: [number, number, number],
  right: [number, number, number],
): boolean {
  return left.every((value, index) => value === right[index]);
}

export function resolveHslReferenceVisible(
  mode: Viewport3DHslReferenceMode,
  vectorColorMode: string,
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return vectorColorMode === "orientation";
}
