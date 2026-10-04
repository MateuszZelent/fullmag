import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import type { VisualizationStatePatch } from "@/kernel/api/apiTypes";
import type { CameraRegistryCameraState } from "@/kernel/visualization/CameraRegistryController";

import {
  resolveViewport3DCameraFit,
  VIEWPORT_3D_WORLD_UP,
  type Viewport3DCameraChange,
} from "../layers/CameraControls";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
} from "../viewport3dStore";

export type SavedViewportCameraPatch = NonNullable<
  VisualizationStatePatch["camera"]
>;

export interface SavedViewportCameraOptions {
  bounds: Viewport3DBounds | null;
  enabled: boolean;
  identityKey: string | null | undefined;
}

export interface SavedViewportCameraController {
  activeIdentityKey: string | null;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraResource: CameraRegistryCameraState;
  cameraState: Viewport3DCameraState;
  beginInteraction: (epoch?: number) => number;
  endInteraction: (epoch?: number) => void;
  fitCamera: () => boolean;
  patchCamera: (patch: SavedViewportCameraPatch, epoch?: number) => boolean;
  resetCamera: () => boolean;
  saveCameraState: (camera: Viewport3DCameraChange, epoch?: number) => boolean;
}

interface SavedViewportCameraSnapshot {
  camera: CameraRegistryCameraState;
  identityKey: string | null;
}

type SavedViewportCameraListener = () => void;

interface SavedViewportCameraStore {
  activate: (identityKey: string | null) => void;
  beginInteraction: (identityKey: string, epoch?: number) => number;
  endInteraction: (identityKey: string, epoch?: number) => void;
  fitCamera: (
    identityKey: string,
    bounds: Viewport3DBounds | null,
  ) => boolean;
  getSnapshot: () => SavedViewportCameraSnapshot;
  getSnapshotForIdentity: (
    identityKey: string | null,
  ) => SavedViewportCameraSnapshot;
  patchCamera: (
    identityKey: string,
    patch: SavedViewportCameraPatch,
    epoch?: number,
  ) => boolean;
  resetCamera: (identityKey: string) => boolean;
  saveCameraState: (
    identityKey: string,
    camera: Viewport3DCameraChange,
    epoch?: number,
  ) => boolean;
  subscribe: (listener: SavedViewportCameraListener) => () => void;
}

const DEFAULT_FOV_DEGREES = 42;
const MAX_SAVED_VIEWPORT_CAMERA_SNAPSHOTS = 8;

export function normalizeSavedViewportCameraIdentity(
  enabled: boolean,
  identityKey: string | null | undefined,
): string | null {
  if (!enabled || typeof identityKey !== "string") return null;
  const normalized = identityKey.trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneCameraState(
  camera: CameraRegistryCameraState,
): CameraRegistryCameraState {
  return {
    fov_degrees: camera.fov_degrees,
    orthographic_scale: camera.orthographic_scale ?? null,
    position: [camera.position[0], camera.position[1], camera.position[2]],
    projection:
      camera.projection === "orthographic" ? "orthographic" : "perspective",
    target: [camera.target[0], camera.target[1], camera.target[2]],
    up: [camera.up[0], camera.up[1], camera.up[2]],
  };
}

function defaultCameraState(): CameraRegistryCameraState {
  return {
    fov_degrees: DEFAULT_FOV_DEGREES,
    orthographic_scale: null,
    position: [
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.position[0],
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.position[1],
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.position[2],
    ],
    projection: "perspective",
    target: [
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.target[0],
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.target[1],
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.target[2],
    ],
    up: [
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.up[0],
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.up[1],
      DEFAULT_VIEWPORT_3D_CAMERA_STATE.up[2],
    ],
  };
}

function createSnapshot(identityKey: string | null): SavedViewportCameraSnapshot {
  return {
    camera: defaultCameraState(),
    identityKey,
  };
}

function toFiniteVector3(
  value: readonly number[] | null | undefined,
  fallback: readonly number[],
): [number, number, number] {
  if (!value || value.length < 3) {
    return [fallback[0], fallback[1], fallback[2]];
  }
  const next = [Number(value[0]), Number(value[1]), Number(value[2])];
  return next.every(Number.isFinite)
    ? [next[0], next[1], next[2]]
    : [fallback[0], fallback[1], fallback[2]];
}

function applyPatch(
  base: CameraRegistryCameraState,
  patch: SavedViewportCameraPatch,
): CameraRegistryCameraState {
  const next = cloneCameraState(base);
  if (typeof patch.fov_degrees === "number" && Number.isFinite(patch.fov_degrees)) {
    next.fov_degrees = patch.fov_degrees;
  }
  if ("orthographic_scale" in patch) {
    next.orthographic_scale =
      typeof patch.orthographic_scale === "number" &&
      Number.isFinite(patch.orthographic_scale)
        ? patch.orthographic_scale
        : null;
  }
  if (patch.projection === "orthographic" || patch.projection === "perspective") {
    next.projection = patch.projection;
  }
  if ("position" in patch) {
    next.position = toFiniteVector3(patch.position, next.position);
  }
  if ("target" in patch) {
    next.target = toFiniteVector3(patch.target, next.target);
  }
  if ("up" in patch) {
    next.up = toFiniteVector3(patch.up, next.up);
  }
  return next;
}

function cameraStatesEqual(
  left: CameraRegistryCameraState,
  right: CameraRegistryCameraState,
): boolean {
  return (
    left.fov_degrees === right.fov_degrees &&
    left.orthographic_scale === right.orthographic_scale &&
    left.projection === right.projection &&
    left.position.every((value, index) => value === right.position[index]) &&
    left.target.every((value, index) => value === right.target[index]) &&
    left.up.every((value, index) => value === right.up[index])
  );
}

function buildCameraPatch(camera: Viewport3DCameraChange): SavedViewportCameraPatch {
  return {
    position: camera.position,
    target: camera.target,
    up: camera.up ?? VIEWPORT_3D_WORLD_UP,
    ...(camera.projection === undefined
      ? {}
      : { projection: camera.projection }),
    ...(camera.orthographicScale === undefined
      ? {}
      : { orthographic_scale: camera.orthographicScale }),
  };
}

function createStore(): SavedViewportCameraStore {
  // The store belongs to one hook instance. It retains at most eight saved
  // identities using insertion order as an LRU list; live/null is never put
  // in this map.
  const inactiveSnapshot = createSnapshot(null);
  const savedSnapshots = new Map<string, SavedViewportCameraSnapshot>();
  let activeIdentityKey: string | null = null;
  let activeSnapshot = inactiveSnapshot;
  let activeInteractionEpoch: number | null = null;
  let interactionActive = false;
  let interactionEpochExplicit = false;
  let interactionEpochSequence = 0;
  const listeners = new Set<SavedViewportCameraListener>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const rememberSnapshot = (
    identityKey: string,
    nextSnapshot: SavedViewportCameraSnapshot,
  ): void => {
    savedSnapshots.delete(identityKey);
    savedSnapshots.set(identityKey, nextSnapshot);
    while (savedSnapshots.size > MAX_SAVED_VIEWPORT_CAMERA_SNAPSHOTS) {
      const oldestIdentityKey = savedSnapshots.keys().next().value;
      if (typeof oldestIdentityKey !== "string") break;
      savedSnapshots.delete(oldestIdentityKey);
    }
  };

  const snapshotForIdentity = (
    identityKey: string,
  ): SavedViewportCameraSnapshot => {
    return (
      savedSnapshots.get(identityKey) ?? createSnapshot(identityKey)
    );
  };

  const setCamera = (
    identityKey: string,
    nextCamera: CameraRegistryCameraState,
  ): boolean => {
    if (activeIdentityKey !== identityKey) return false;
    if (cameraStatesEqual(activeSnapshot.camera, nextCamera)) return false;
    activeSnapshot = { camera: cloneCameraState(nextCamera), identityKey };
    rememberSnapshot(identityKey, activeSnapshot);
    notify();
    return true;
  };

  const activate = (identityKey: string | null): void => {
    if (activeIdentityKey === identityKey) {
      if (identityKey !== null) {
        const cachedSnapshot = savedSnapshots.get(identityKey);
        if (cachedSnapshot && cachedSnapshot !== activeSnapshot) {
          activeSnapshot = cachedSnapshot;
        }
        if (activeSnapshot.identityKey === identityKey) {
          rememberSnapshot(identityKey, activeSnapshot);
        }
      }
      return;
    }
    interactionActive = false;
    activeInteractionEpoch = null;
    interactionEpochExplicit = false;
    activeIdentityKey = identityKey;
    activeSnapshot =
      identityKey === null ? inactiveSnapshot : snapshotForIdentity(identityKey);
    if (identityKey !== null) rememberSnapshot(identityKey, activeSnapshot);
    notify();
  };

  const ensureInteractionEpoch = (epoch?: number): boolean => {
    if (
      epoch === undefined &&
      activeInteractionEpoch !== null &&
      interactionEpochExplicit
    ) {
      interactionActive = false;
      activeInteractionEpoch = null;
      interactionEpochExplicit = false;
    }
    if (
      epoch !== undefined &&
      (activeInteractionEpoch === null || epoch !== activeInteractionEpoch)
    ) {
      return false;
    }
    return true;
  };

  const patchCamera = (
    identityKey: string,
    patch: SavedViewportCameraPatch,
    epoch?: number,
  ): boolean => {
    if (activeIdentityKey !== identityKey) activate(identityKey);
    if (!ensureInteractionEpoch(epoch)) return false;
    return setCamera(identityKey, applyPatch(activeSnapshot.camera, patch));
  };

  return {
    activate,
    beginInteraction(identityKey, epoch) {
      if (activeIdentityKey !== identityKey) {
        activate(identityKey);
      }
      if (epoch === undefined && activeInteractionEpoch !== null) {
        interactionActive = true;
        return activeInteractionEpoch;
      }
      const nextEpoch = epoch ?? interactionEpochSequence + 1;
      interactionEpochSequence = Math.max(interactionEpochSequence, nextEpoch);
      activeInteractionEpoch = nextEpoch;
      interactionActive = true;
      interactionEpochExplicit = epoch !== undefined;
      return nextEpoch;
    },
    endInteraction(identityKey, epoch) {
      if (activeIdentityKey !== identityKey || !interactionActive) return;
      if (
        epoch !== undefined &&
        activeInteractionEpoch !== null &&
        epoch !== activeInteractionEpoch
      ) {
        return;
      }
      interactionActive = false;
      activeInteractionEpoch = null;
      interactionEpochExplicit = false;
    },
    fitCamera(identityKey, bounds) {
      if (activeIdentityKey !== identityKey) activate(identityKey);
      ensureInteractionEpoch();
      const fit = resolveViewport3DCameraFit(bounds);
      return setCamera(identityKey, {
        ...activeSnapshot.camera,
        position: fit.position,
        target: fit.target,
        up: [
          VIEWPORT_3D_WORLD_UP[0],
          VIEWPORT_3D_WORLD_UP[1],
          VIEWPORT_3D_WORLD_UP[2],
        ],
      });
    },
    getSnapshot() {
      return activeSnapshot;
    },
    getSnapshotForIdentity(identityKey) {
      if (identityKey === null) return inactiveSnapshot;
      if (identityKey === activeIdentityKey) return activeSnapshot;
      return snapshotForIdentity(identityKey);
    },
    patchCamera,
    resetCamera(identityKey) {
      if (activeIdentityKey !== identityKey) activate(identityKey);
      ensureInteractionEpoch();
      return setCamera(identityKey, defaultCameraState());
    },
    saveCameraState(identityKey, camera, epoch) {
      return patchCamera(identityKey, buildCameraPatch(camera), epoch);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useSavedViewportCamera({
  bounds,
  enabled,
  identityKey,
}: SavedViewportCameraOptions): SavedViewportCameraController {
  const store = useMemo(() => createStore(), []);
  const activeIdentityKey = normalizeSavedViewportCameraIdentity(
    enabled,
    identityKey,
  );
  const activeIdentityRef = useRef<string | null>(activeIdentityKey);
  // Old event handlers can run after React has rendered a new selection. Keep
  // their captured key fenced against the current render before touching the
  // local store.
  useLayoutEffect(() => {
    activeIdentityRef.current = activeIdentityKey;
  }, [activeIdentityKey]);
  const storeSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => {
    if (activeIdentityRef.current !== activeIdentityKey) return;
    store.activate(activeIdentityKey);
  }, [activeIdentityKey, activeIdentityRef, store]);

  // React may render once before the identity activation effect runs. Fence
  // that render synchronously so A/B/live transitions can never display the
  // wrong camera. A cached saved identity is returned immediately, without
  // waiting for the activation effect.
  const snapshot = useMemo(
    () =>
      activeIdentityKey === storeSnapshot.identityKey
        ? storeSnapshot
        : store.getSnapshotForIdentity(activeIdentityKey),
    [activeIdentityKey, store, storeSnapshot],
  );
  const cameraResource = useMemo(
    () => cloneCameraState(snapshot.camera),
    [snapshot],
  );
  const cameraState = useMemo<Viewport3DCameraState>(
    () => ({
      position: [
        snapshot.camera.position[0],
        snapshot.camera.position[1],
        snapshot.camera.position[2],
      ],
      target: [
        snapshot.camera.target[0],
        snapshot.camera.target[1],
        snapshot.camera.target[2],
      ],
      up: [snapshot.camera.up[0], snapshot.camera.up[1], snapshot.camera.up[2]],
    }),
    [snapshot],
  );

  const patchCamera = useCallback(
    (patch: SavedViewportCameraPatch, epoch?: number) => {
      if (
        !activeIdentityKey ||
        activeIdentityRef.current !== activeIdentityKey
      ) {
        return false;
      }
      return store.patchCamera(activeIdentityKey, patch, epoch);
    },
    [activeIdentityKey, activeIdentityRef, store],
  );
  const saveCameraState = useCallback(
    (camera: Viewport3DCameraChange, epoch?: number) => {
      if (
        !activeIdentityKey ||
        activeIdentityRef.current !== activeIdentityKey
      ) {
        return false;
      }
      return store.saveCameraState(activeIdentityKey, camera, epoch);
    },
    [activeIdentityKey, activeIdentityRef, store],
  );
  const beginInteraction = useCallback(
    (epoch?: number) =>
      activeIdentityKey && activeIdentityRef.current === activeIdentityKey
        ? store.beginInteraction(activeIdentityKey, epoch)
        : 0,
    [activeIdentityKey, activeIdentityRef, store],
  );
  const endInteraction = useCallback(
    (epoch?: number) => {
      if (
        activeIdentityKey &&
        activeIdentityRef.current === activeIdentityKey
      ) {
        store.endInteraction(activeIdentityKey, epoch);
      }
    },
    [activeIdentityKey, activeIdentityRef, store],
  );
  const fitCamera = useCallback(() => {
    if (
      !activeIdentityKey ||
      activeIdentityRef.current !== activeIdentityKey
    ) {
      return false;
    }
    return store.fitCamera(activeIdentityKey, bounds);
  }, [activeIdentityKey, activeIdentityRef, bounds, store]);
  const resetCamera = useCallback(() => {
    if (
      !activeIdentityKey ||
      activeIdentityRef.current !== activeIdentityKey
    ) {
      return false;
    }
    return store.resetCamera(activeIdentityKey);
  }, [activeIdentityKey, activeIdentityRef, store]);

  return {
    activeIdentityKey,
    cameraOrthographicScale: snapshot.camera.orthographic_scale ?? null,
    cameraProjection: snapshot.camera.projection,
    cameraResource,
    cameraState,
    beginInteraction,
    endInteraction,
    fitCamera,
    patchCamera,
    resetCamera,
    saveCameraState,
  };
}
