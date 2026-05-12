"use client";

import { useSyncExternalStore } from "react";

export interface Viewport3DCameraState {
  position: [number, number, number];
  target: [number, number, number];
}

export interface Viewport3DCommandState {
  camera: Viewport3DCameraState;
  fitRevision: number;
  resetCameraRevision: number;
  widgets: Viewport3DWidgetState;
}

type Viewport3DListener = () => void;
export type Viewport3DHslReferenceMode = "auto" | "off" | "on";
export type Viewport3DCameraProjection = "perspective" | "orthographic";

export interface Viewport3DWidgetState {
  cameraProjection: Viewport3DCameraProjection;
  hslReferenceMode: Viewport3DHslReferenceMode;
  viewCubeVisible: boolean;
}

const DEFAULT_VIEWPORT_3D_STATE: Viewport3DCommandState = {
  camera: {
    position: [2, 1.4, 2],
    target: [0, 0, 0],
  },
  fitRevision: 0,
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
    this.snapshot = DEFAULT_VIEWPORT_3D_STATE;
    this.notify();
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
