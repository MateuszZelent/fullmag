"use client";

import { useSyncExternalStore } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID,
  type Viewport3DVisualProfileId,
} from "./viewport3dVisualProfile";

export interface Viewport3DCameraState {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
}

export interface Viewport3DCommandState {
  camera: Viewport3DCameraState;
  captureReturnProfileId: Viewport3DVisualProfileId | null;
  captureRevision: number;
  fitRevision: number;
  resetCameraRevision: number;
  visualProfileId: Viewport3DVisualProfileId;
  widgets: Viewport3DWidgetState;
}

type Viewport3DListener = () => void;
export type Viewport3DHslReferenceMode = "auto" | "off" | "on";
export type Viewport3DCameraProjection = "perspective" | "orthographic";

export interface Viewport3DWidgetState {
  cameraDialogOpen: boolean;
  cameraProjection: Viewport3DCameraProjection;
  effectAmbientOcclusion: boolean;
  effectAntialias: boolean;
  effectBloom: boolean;
  hslReferenceMode: Viewport3DHslReferenceMode;
  settingsDialogOpen: boolean;
  viewCubeVisible: boolean;
}

export const DEFAULT_VIEWPORT_3D_CAMERA_STATE: Viewport3DCameraState = {
  position: [2e-6, 1.4e-6, 2e-6],
  target: [0, 0, 0],
  up: [0, 0, 1],
};

const DEFAULT_VIEWPORT_3D_STATE: Viewport3DCommandState = {
  camera: {
    ...DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  },
  captureReturnProfileId: null,
  captureRevision: 0,
  fitRevision: 0,
  resetCameraRevision: 0,
  visualProfileId: DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID,
  widgets: {
    cameraDialogOpen: false,
    cameraProjection: "perspective",
    effectAmbientOcclusion: false,
    effectAntialias: true,
    effectBloom: false,
    hslReferenceMode: "auto",
    settingsDialogOpen: false,
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

  requestCapture(): void {
    const captureReturnProfileId =
      this.snapshot.visualProfileId === "capture"
        ? null
        : this.snapshot.visualProfileId;
    this.snapshot = {
      ...this.snapshot,
      captureReturnProfileId,
      captureRevision: this.snapshot.captureRevision + 1,
      visualProfileId: "capture",
    };
    this.notify();
  }

  completeCapture(): void {
    if (this.snapshot.captureReturnProfileId === null) return;
    this.snapshot = {
      ...this.snapshot,
      visualProfileId: this.snapshot.captureReturnProfileId,
      captureReturnProfileId: null,
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

  setVisualProfile(profileId: Viewport3DVisualProfileId): void {
    if (
      this.snapshot.visualProfileId === profileId &&
      this.snapshot.captureReturnProfileId === null
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      captureReturnProfileId: null,
      visualProfileId: profileId,
    };
    this.notify();
  }

  setCamera(camera: Viewport3DCameraState): void {
    if (sameViewport3DCameraState(this.snapshot.camera, camera)) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      camera,
    };
    this.notify();
  }

  setCameraView({
    camera,
    projection,
  }: {
    camera: Viewport3DCameraState;
    projection: Viewport3DCameraProjection;
  }): void {
    if (
      sameViewport3DCameraState(this.snapshot.camera, camera) &&
      this.snapshot.widgets.cameraProjection === projection
    ) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      camera,
      widgets: {
        ...this.snapshot.widgets,
        cameraProjection: projection,
      },
    };
    this.notify();
  }

  subscribe(listener: Viewport3DListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toggleCameraProjection(): void {
    this.setCameraProjection(
      this.snapshot.widgets.cameraProjection === "perspective"
        ? "orthographic"
        : "perspective",
    );
  }

  setCameraProjection(projection: Viewport3DCameraProjection): void {
    if (this.snapshot.widgets.cameraProjection === projection) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        cameraProjection: projection,
      },
    };
    this.notify();
  }

  setCameraDialogOpen(open: boolean): void {
    if (this.snapshot.widgets.cameraDialogOpen === open) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        cameraDialogOpen: open,
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

  setSettingsDialogOpen(open: boolean): void {
    if (this.snapshot.widgets.settingsDialogOpen === open) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        settingsDialogOpen: open,
      },
    };
    this.notify();
  }

  setEffectAmbientOcclusion(enabled: boolean): void {
    if (this.snapshot.widgets.effectAmbientOcclusion === enabled) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: { ...this.snapshot.widgets, effectAmbientOcclusion: enabled },
    };
    this.notify();
  }

  setEffectAntialias(enabled: boolean): void {
    if (this.snapshot.widgets.effectAntialias === enabled) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: { ...this.snapshot.widgets, effectAntialias: enabled },
    };
    this.notify();
  }

  setEffectBloom(enabled: boolean): void {
    if (this.snapshot.widgets.effectBloom === enabled) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: { ...this.snapshot.widgets, effectBloom: enabled },
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

export function sameViewport3DCameraState(
  left: Viewport3DCameraState,
  right: Viewport3DCameraState,
): boolean {
  return (
    sameVector(left.position, right.position) &&
    sameVector(left.target, right.target) &&
    sameVector(
      left.up ?? DEFAULT_VIEWPORT_3D_CAMERA_STATE.up ?? [0, 0, 1],
      right.up ?? DEFAULT_VIEWPORT_3D_CAMERA_STATE.up ?? [0, 0, 1],
    )
  );
}

export function viewport3DCameraViewSignature({
  camera,
  projection,
}: {
  camera: Viewport3DCameraState;
  projection: Viewport3DCameraProjection;
}): string {
  return [
    ...camera.position,
    ...camera.target,
    ...(camera.up ?? DEFAULT_VIEWPORT_3D_CAMERA_STATE.up ?? [0, 0, 1]),
    projection,
  ].join(":");
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
  const up = vector3(camera?.up) ?? DEFAULT_VIEWPORT_3D_CAMERA_STATE.up;
  if (!position || !target) {
    return DEFAULT_VIEWPORT_3D_CAMERA_STATE;
  }
  return { position, target, up };
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
