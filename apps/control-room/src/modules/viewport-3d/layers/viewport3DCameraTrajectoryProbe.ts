import type { CameraRegistryCameraState } from "@/kernel/visualization/CameraRegistryController";

import type { Viewport3DCameraState } from "../viewport3dStore";
import type { Viewport3DCameraGestureSource } from "./viewport3DCameraGesture";
import type { Viewport3DLiveCameraSnapshot } from "./viewport3DCameraState";

export type Viewport3DCameraTrajectoryReason =
  | "cancel"
  | "change"
  | "commit"
  | "remote"
  | "settle"
  | "start";

export interface Viewport3DCameraTrajectorySample {
  active: boolean;
  committedCamera: CameraRegistryCameraState | null;
  epoch: number;
  frame: number;
  liveCamera: Viewport3DLiveCameraSnapshot | null;
  reason: Viewport3DCameraTrajectoryReason;
  registry: {
    dirty: boolean;
    lastRemoteRevision: number | string | null;
    localVersion: number;
    persistedShadow: CameraRegistryCameraState | null;
  } | null;
  source: Viewport3DCameraGestureSource | null;
  storeCamera: Viewport3DCameraState | null;
  timestamp: number;
}

export interface Viewport3DCameraTrajectoryProbe {
  clear(): void;
  record(sample: Viewport3DCameraTrajectorySample): void;
  size(): number;
  snapshot(): Viewport3DCameraTrajectorySample[];
}

interface Viewport3DCameraTrajectoryProbeOptions {
  capacity: number;
  enabled: boolean;
}

const NOOP_SNAPSHOT: Viewport3DCameraTrajectorySample[] = [];
const NOOP_PROBE: Viewport3DCameraTrajectoryProbe = {
  clear() {},
  record() {},
  size: () => 0,
  snapshot: () => NOOP_SNAPSHOT,
};

export function createViewport3DCameraTrajectoryProbe({
  capacity,
  enabled,
}: Viewport3DCameraTrajectoryProbeOptions): Viewport3DCameraTrajectoryProbe {
  if (!enabled) return NOOP_PROBE;
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  const samples: Viewport3DCameraTrajectorySample[] = [];

  return {
    clear() {
      samples.length = 0;
    },
    record(sample) {
      if (samples.length === boundedCapacity) samples.shift();
      samples.push(cloneSample(sample));
    },
    size: () => samples.length,
    snapshot: () => samples.map(cloneSample),
  };
}

const viewport3DCameraTrajectoryProbe = createViewport3DCameraTrajectoryProbe({
  capacity: 4_096,
  enabled:
    process.env.NEXT_PUBLIC_AUDIT_BUILD === "1" ||
    process.env.NODE_ENV !== "production",
});

export function recordViewport3DCameraTrajectorySample(
  sample: Viewport3DCameraTrajectorySample,
): void {
  viewport3DCameraTrajectoryProbe.record(sample);
}

export function installViewport3DCameraTrajectoryProbeForBrowser(): void {
  if (typeof window === "undefined" || viewport3DCameraTrajectoryProbe === NOOP_PROBE) {
    return;
  }
  window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__ = viewport3DCameraTrajectoryProbe;
}

declare global {
  interface Window {
    __FULLMAG_VIEWPORT3D_CAMERA_AUDIT__?: Viewport3DCameraTrajectoryProbe;
  }
}

function cloneCamera(
  camera: CameraRegistryCameraState | null,
): CameraRegistryCameraState | null {
  if (!camera) return null;
  return {
    ...camera,
    position: [...camera.position],
    target: [...camera.target],
    up: [...camera.up],
  };
}

function cloneSample(
  sample: Viewport3DCameraTrajectorySample,
): Viewport3DCameraTrajectorySample {
  return {
    ...sample,
    committedCamera: cloneCamera(sample.committedCamera),
    liveCamera: sample.liveCamera
      ? {
          ...sample.liveCamera,
          position: [...sample.liveCamera.position],
          target: [...sample.liveCamera.target],
          up: [...sample.liveCamera.up],
        }
      : null,
    registry: sample.registry
      ? {
          ...sample.registry,
          persistedShadow: cloneCamera(sample.registry.persistedShadow),
        }
      : null,
    storeCamera: sample.storeCamera
      ? {
          ...sample.storeCamera,
          position: [...sample.storeCamera.position],
          target: [...sample.storeCamera.target],
          up: [...sample.storeCamera.up],
        }
      : null,
  };
}
