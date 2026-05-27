import { describe, expect, it, vi } from "vitest";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";

import {
  CameraRegistryController,
  DEFAULT_CAMERA_REGISTRY_STATE,
  type CameraRegistryCameraState,
} from "./CameraRegistryController";

type CameraPatch = NonNullable<VisualizationStatePatch["camera"]>;

function camera(
  patch: Partial<CameraRegistryCameraState> | CameraPatch = {},
): CameraRegistryCameraState {
  return {
    fov_degrees:
      typeof patch.fov_degrees === "number"
        ? patch.fov_degrees
        : DEFAULT_CAMERA_REGISTRY_STATE.fov_degrees,
    orthographic_scale:
      typeof patch.orthographic_scale === "number"
        ? patch.orthographic_scale
        : null,
    position: vector3(patch.position, DEFAULT_CAMERA_REGISTRY_STATE.position),
    projection:
      patch.projection === "orthographic" || patch.projection === "perspective"
        ? patch.projection
        : DEFAULT_CAMERA_REGISTRY_STATE.projection,
    target: vector3(patch.target, DEFAULT_CAMERA_REGISTRY_STATE.target),
    up: vector3(patch.up, DEFAULT_CAMERA_REGISTRY_STATE.up),
  };
}

function vector3(
  value: readonly number[] | null | undefined,
  fallback: readonly number[],
): number[] {
  return [...(value ?? fallback)];
}

function visualizationState(
  revision: number,
  nextCamera: CameraRegistryCameraState,
): VisualizationStateResource {
  return {
    camera: nextCamera,
    revision,
  } as VisualizationStateResource;
}

function createController({
  documentTarget,
  idleFlushMs,
  intervalMs = 60_000,
  patch,
  windowTarget,
}: {
  documentTarget?: ConstructorParameters<typeof CameraRegistryController>[0]["documentTarget"];
  idleFlushMs?: number | null;
  intervalMs?: number;
  patch?: (patch: VisualizationStatePatch) => Promise<VisualizationStateResource>;
  windowTarget?: ConstructorParameters<typeof CameraRegistryController>[0]["windowTarget"];
} = {}) {
  const patchSpy =
    patch ??
    vi.fn(async (nextPatch: VisualizationStatePatch) =>
      visualizationState(2, camera(nextPatch.camera ?? {})),
    );
  return {
    controller: new CameraRegistryController({
      api: { patch: patchSpy },
      documentTarget,
      idleFlushMs,
      intervalMs,
      now: () => 0,
      windowTarget,
    }),
    patchSpy,
  };
}

function createEventTarget<T extends Record<string, unknown>>(state: T) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    },
    target: {
      ...state,
      addEventListener(type: string, listener: (event: Event) => void) {
        const nextListeners = listeners.get(type) ?? new Set();
        nextListeners.add(listener);
        listeners.set(type, nextListeners);
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        listeners.get(type)?.delete(listener);
      },
    },
  };
}

describe("CameraRegistryController", () => {
  it("adopts backend camera state until the local registry is dirty", () => {
    const { controller } = createController();
    const remote = camera({
      position: [1, 2, 3],
      projection: "orthographic",
      target: [0, 0, 0],
    });

    controller.observeRemoteState(visualizationState(11, remote));

    expect(controller.getSnapshot().camera).toEqual(remote);
    expect(controller.getSnapshot().dirty).toBe(false);
  });

  it("keeps local camera changes in the registry without patching immediately", () => {
    const { controller, patchSpy } = createController();
    const remote = camera({ position: [0, 0, 1] });
    controller.observeRemoteState(visualizationState(1, remote));

    controller.patchCamera({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
      up: [0, 0, 1],
    });

    expect(controller.getSnapshot().camera.position).toEqual([3, 2, 1]);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("skips backend sync when the registry already matches the observed backend camera", async () => {
    const { controller, patchSpy } = createController();
    const remote = camera({ projection: "orthographic" });

    controller.observeRemoteState(visualizationState(1, remote));
    controller.patchCamera({ projection: "orthographic" });
    await controller.flushDue();

    expect(controller.getSnapshot().dirty).toBe(false);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("syncs the full camera state on the background watcher tick", async () => {
    vi.useFakeTimers();
    const { controller, patchSpy } = createController({
      idleFlushMs: null,
      intervalMs: 60_000,
      patch: vi.fn(async (nextPatch: VisualizationStatePatch) =>
        visualizationState(22, camera(nextPatch.camera ?? {})),
      ),
    });
    controller.start();
    controller.patchCamera({ projection: "orthographic" });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(patchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(patchSpy).toHaveBeenCalledWith({
      camera: {
        fov_degrees: DEFAULT_CAMERA_REGISTRY_STATE.fov_degrees,
        orthographic_scale: null,
        position: DEFAULT_CAMERA_REGISTRY_STATE.position,
        projection: "orthographic",
        target: DEFAULT_CAMERA_REGISTRY_STATE.target,
        up: DEFAULT_CAMERA_REGISTRY_STATE.up,
      },
    });
    expect(controller.getSnapshot().dirty).toBe(false);

    controller.stop();
    vi.useRealTimers();
  });

  it("syncs a dirty camera after the idle window", async () => {
    vi.useFakeTimers();
    const { controller, patchSpy } = createController({
      idleFlushMs: 5_000,
      intervalMs: 60_000,
      patch: vi.fn(async (nextPatch: VisualizationStatePatch) =>
        visualizationState(23, camera(nextPatch.camera ?? {})),
      ),
    });
    controller.start();
    controller.patchCamera({ projection: "orthographic" });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(patchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().lastSyncedAt).toBe(0);
    expect(controller.getSnapshot().dirty).toBe(false);

    controller.stop();
    vi.useRealTimers();
  });

  it("defers sync while a camera interaction is active", async () => {
    vi.useFakeTimers();
    const { controller, patchSpy } = createController({
      idleFlushMs: 500,
      intervalMs: 60_000,
      patch: vi.fn(async (nextPatch: VisualizationStatePatch) =>
        visualizationState(24, camera(nextPatch.camera ?? {})),
      ),
    });
    controller.start();

    controller.beginInteraction();
    controller.patchCamera({ position: [4, 5, 6] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(patchSpy).not.toHaveBeenCalled();

    controller.endInteraction();
    await vi.advanceTimersByTimeAsync(499);
    expect(patchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(patchSpy).toHaveBeenCalledTimes(1);

    controller.stop();
    vi.useRealTimers();
  });

  it("does not let stale remote camera state overwrite dirty local camera state", () => {
    const { controller } = createController();
    const remote = camera({ position: [0, 0, 1] });
    controller.observeRemoteState(visualizationState(1, remote));

    controller.patchCamera({
      position: [9, 8, 7],
      target: [0, 0, 0],
      up: [0, 0, 1],
    });
    controller.observeRemoteState(visualizationState(2, remote));

    expect(controller.getSnapshot().camera.position).toEqual([9, 8, 7]);
    expect(controller.getSnapshot().dirty).toBe(true);
  });

  it("does not let remote camera state overwrite an active interaction", () => {
    const { controller } = createController();
    const firstRemote = camera({ position: [0, 0, 1] });
    const nextRemote = camera({ position: [9, 8, 7] });
    controller.observeRemoteState(visualizationState(1, firstRemote));

    controller.beginInteraction();
    controller.observeRemoteState(visualizationState(2, nextRemote));

    expect(controller.getSnapshot().camera.position).toEqual([0, 0, 1]);
    expect(controller.getSnapshot().persistedShadow?.position).toEqual([9, 8, 7]);
    expect(controller.getSnapshot().interactionActive).toBe(true);
  });

  it("uses a stable camera signature so sub-epsilon jitter does not become dirty", async () => {
    const { controller, patchSpy } = createController();
    const remote = camera({ position: [1, 2, 3] });
    controller.observeRemoteState(visualizationState(1, remote));

    controller.patchCamera({ position: [1 + 1e-13, 2, 3] });
    await controller.flushDue();

    expect(controller.getSnapshot().camera.position).toEqual([1, 2, 3]);
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("flushes dirty camera state when the document becomes hidden", () => {
    const documentTarget = createEventTarget({ visibilityState: "visible" });
    const { controller, patchSpy } = createController({
      documentTarget: documentTarget.target,
      patch: vi.fn(async (nextPatch: VisualizationStatePatch) =>
        visualizationState(25, camera(nextPatch.camera ?? {})),
      ),
      windowTarget: null,
    });
    controller.start();
    controller.patchCamera({ projection: "orthographic" });

    documentTarget.target.visibilityState = "hidden";
    documentTarget.dispatch("visibilitychange");

    expect(patchSpy).toHaveBeenCalledTimes(1);

    controller.stop();
  });

  it("flushes dirty camera state on pagehide", () => {
    const windowTarget = createEventTarget({});
    const { controller, patchSpy } = createController({
      documentTarget: null,
      patch: vi.fn(async (nextPatch: VisualizationStatePatch) =>
        visualizationState(26, camera(nextPatch.camera ?? {})),
      ),
      windowTarget: windowTarget.target,
    });
    controller.start();
    controller.patchCamera({ projection: "orthographic" });

    windowTarget.dispatch("pagehide");

    expect(patchSpy).toHaveBeenCalledTimes(1);

    controller.stop();
  });

  it("suppresses visualization invalidation for its own camera sync revision", async () => {
    const { controller } = createController({
      patch: vi.fn(async (nextPatch: VisualizationStatePatch) =>
        visualizationState(44, camera(nextPatch.camera ?? {})),
      ),
    });

    controller.patchCamera({ projection: "orthographic" });
    await controller.flushDue();

    expect(
      controller.shouldSuppressInvalidation(VISUALIZATION_STATE_PATH, 44),
    ).toBe(true);
    expect(
      controller.shouldSuppressInvalidation(VISUALIZATION_STATE_PATH, 44),
    ).toBe(false);
  });

  it("does not adopt an older backend camera revision after syncing local state", async () => {
    const staleRemote = camera({ position: [0, 0, 1] });
    const syncedCamera = camera({
      position: [4, 5, 6],
      target: [0, 0, 0],
      up: [0, 0, 1],
    });
    const { controller } = createController({
      patch: vi.fn(async () => visualizationState(11, syncedCamera)),
    });

    controller.observeRemoteState(visualizationState(10, staleRemote));
    controller.patchCamera({
      position: syncedCamera.position,
      target: syncedCamera.target,
      up: syncedCamera.up,
    });
    await controller.flushDue();
    controller.observeRemoteState(visualizationState(10, staleRemote));

    expect(controller.getSnapshot().camera).toEqual(syncedCamera);
    expect(controller.getSnapshot().lastRemoteRevision).toBe(11);
  });
});
