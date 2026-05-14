"use client";

import { useSyncExternalStore } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

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

export const DEFAULT_VIEWPORT_3D_CAMERA_STATE: Viewport3DCameraState = {
  position: [2e-6, 1.4e-6, 2e-6],
  target: [0, 0, 0],
};

const DEFAULT_VIEWPORT_3D_STATE: Viewport3DCommandState = {
  camera: {
    ...DEFAULT_VIEWPORT_3D_CAMERA_STATE,
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

export function resolveViewport3DCameraState(
  visualizationState: Pick<VisualizationStateResource, "camera"> | null | undefined,
): Viewport3DCameraState {
  const camera = visualizationState?.camera;
  const position = vector3(camera?.position);
  const target = vector3(camera?.target);
  if (!position || !target) {
    return DEFAULT_VIEWPORT_3D_CAMERA_STATE;
  }
  return { position, target };
}

export function resolveViewport3DCameraProjection(
  visualizationState: Pick<VisualizationStateResource, "camera"> | null | undefined,
): Viewport3DCameraProjection {
  return visualizationState?.camera?.projection === "orthographic"
    ? "orthographic"
    : "perspective";
}

function vector3(value: readonly number[] | null | undefined): [number, number, number] | null {
  if (!value || value.length < 3) return null;
  const next: [number, number, number] = [
    Number(value[0]),
    Number(value[1]),
    Number(value[2]),
  ];
  return next.every(Number.isFinite) ? next : null;
}
