import type {
  RequestOptions,
  ResourceRevision,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";

type CameraRegistryListener = () => void;
type CameraPatch = NonNullable<VisualizationStatePatch["camera"]>;
export type CameraRegistryCameraState = VisualizationStateResource["camera"];
export type CameraRegistryFlushReason =
  | "idle"
  | "manual"
  | "pagehide"
  | "visibilitychange";
type CameraRegistrySource = "default" | "local" | "remote" | "sync";

interface CameraRegistryApi {
  patch: (
    patch: VisualizationStatePatch,
    options?: RequestOptions,
  ) => Promise<VisualizationStateResource>;
}

interface CameraRegistryEventTarget {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

interface CameraRegistryDocumentTarget extends CameraRegistryEventTarget {
  readonly visibilityState?: string;
}

export interface CameraRegistrySnapshot {
  camera: CameraRegistryCameraState;
  dirty: boolean;
  error: Error | null;
  inflightCamera: CameraRegistryCameraState | null;
  lastChangedAt: number | null;
  lastLocalChangedAt: number | null;
  lastRemoteRevision: ResourceRevision | null;
  lastSource: CameraRegistrySource;
  lastSyncedAt: number | null;
  liveView: CameraRegistryCameraState;
  localVersion: number;
  pendingFlushReason: CameraRegistryFlushReason | null;
  persistedShadow: CameraRegistryCameraState | null;
  persistedVersion: ResourceRevision | null;
  remoteCamera: CameraRegistryCameraState | null;
  syncInFlight: boolean;
  version: number;
}

interface CameraRegistryControllerOptions {
  api: CameraRegistryApi;
  documentTarget?: CameraRegistryDocumentTarget | null;
  idleFlushMs?: number | null;
  now?: () => number;
  windowTarget?: CameraRegistryEventTarget | null;
}

const DEFAULT_CAMERA_REGISTRY_IDLE_FLUSH_MS = 8_000;

export const DEFAULT_CAMERA_REGISTRY_STATE: CameraRegistryCameraState = {
  fov_degrees: 42,
  orthographic_scale: null,
  position: [2e-6, 1.4e-6, 2e-6],
  projection: "perspective",
  target: [0, 0, 0],
  up: [0, 0, 1],
};

const INITIAL_SNAPSHOT: CameraRegistrySnapshot = {
  camera: cloneCameraState(DEFAULT_CAMERA_REGISTRY_STATE),
  dirty: false,
  error: null,
  inflightCamera: null,
  lastChangedAt: null,
  lastLocalChangedAt: null,
  lastRemoteRevision: null,
  lastSource: "default",
  lastSyncedAt: null,
  liveView: cloneCameraState(DEFAULT_CAMERA_REGISTRY_STATE),
  localVersion: 0,
  pendingFlushReason: null,
  persistedShadow: null,
  persistedVersion: null,
  remoteCamera: null,
  syncInFlight: false,
  version: 0,
};

export class CameraRegistryController {
  private readonly api: CameraRegistryApi;
  private readonly documentTarget: CameraRegistryDocumentTarget | null;
  private readonly idleFlushMs: number | null;
  private readonly listeners = new Set<CameraRegistryListener>();
  private readonly now: () => number;
  private flushPromise: Promise<void> | null = null;
  private readonly handlePageHide = () => {
    void this.flushDue("pagehide");
  };
  private readonly handleVisibilityChange = () => {
    if (this.documentTarget?.visibilityState === "hidden") {
      void this.flushDue("visibilitychange");
    }
  };
  private idleFlushId: ReturnType<typeof setTimeout> | null = null;
  private inflightCameraInvalidationSuppressed = false;
  private activeInteractionEpoch: number | null = null;
  private interactionActive = false;
  private interactionEpochSequence = 0;
  private localDirty = false;
  private snapshot: CameraRegistrySnapshot = INITIAL_SNAPSHOT;
  private started = false;
  private readonly suppressedCameraInvalidationRevisions = new Set<string>();
  private readonly windowTarget: CameraRegistryEventTarget | null;

  constructor({
    api,
    documentTarget =
      typeof document === "undefined" ? null : document,
    idleFlushMs = DEFAULT_CAMERA_REGISTRY_IDLE_FLUSH_MS,
    now = Date.now,
    windowTarget =
      typeof window === "undefined" ? null : window,
  }: CameraRegistryControllerOptions) {
    this.api = api;
    this.documentTarget = documentTarget;
    this.idleFlushMs = idleFlushMs;
    this.now = now;
    this.windowTarget = windowTarget;
  }

  getSnapshot(): CameraRegistrySnapshot {
    return this.snapshot;
  }

  observeRemoteState(
    state: VisualizationStateResource | null | undefined,
  ): void {
    this.applyRemoteState(state, "remote", null);
  }

  beginInteraction(epoch?: number): number {
    this.clearIdleFlushTimer();
    if (epoch === undefined && this.activeInteractionEpoch !== null) {
      return this.activeInteractionEpoch;
    }
    const nextEpoch = epoch ?? this.interactionEpochSequence + 1;
    this.interactionEpochSequence = Math.max(
      this.interactionEpochSequence,
      nextEpoch,
    );
    this.activeInteractionEpoch = nextEpoch;
    this.interactionActive = true;
    return nextEpoch;
  }

  endInteraction(epoch?: number): void {
    if (!this.interactionActive) return;
    if (
      epoch !== undefined &&
      this.activeInteractionEpoch !== null &&
      epoch !== this.activeInteractionEpoch
    ) {
      return;
    }
    this.interactionActive = false;
    this.activeInteractionEpoch = null;

    if (this.snapshot.dirty) {
      this.scheduleIdleFlush();
    }
  }

  cancelInteraction(epoch?: number): void {
    this.endInteraction(epoch);
  }

  private applyRemoteState(
    state: VisualizationStateResource | null | undefined,
    source: CameraRegistrySource,
    syncedAt: number | null,
  ): void {
    if (!state?.camera) return;
    if (isOlderNumericRevision(state.revision, this.snapshot.lastRemoteRevision)) {
      return;
    }

    const previous = this.snapshot;
    const remoteCamera = normalizeCameraState(state.camera);
    let camera = previous.camera;
    let dirty = this.localDirty;
    let error = previous.error;
    let lastSource = previous.lastSource;

    if (!dirty && !this.interactionActive) {
      camera = remoteCamera;
      error = null;
      lastSource = source;
    } else if (cameraStatesEqual(camera, remoteCamera)) {
      dirty = false;
      error = null;
      lastSource = source;
    }

    this.localDirty = dirty;
    this.setSnapshotIfChanged({
      ...previous,
      camera,
      dirty,
      error,
      lastSource,
      lastSyncedAt: syncedAt ?? previous.lastSyncedAt,
      liveView: camera,
      lastRemoteRevision: state.revision,
      pendingFlushReason: dirty ? previous.pendingFlushReason : null,
      persistedShadow: remoteCamera,
      persistedVersion: state.revision,
      remoteCamera,
    });
  }

  patchCamera(patch: CameraPatch, epoch?: number): boolean {
    if (
      epoch !== undefined &&
      (this.activeInteractionEpoch === null ||
        epoch !== this.activeInteractionEpoch)
    ) {
      return false;
    }
    if (!hasCameraPatchKeys(patch)) return false;

    const camera = applyCameraPatch(this.snapshot.camera, patch);
    if (cameraStatesEqual(this.snapshot.camera, camera)) {
      return false;
    }

    this.localDirty = true;
    this.snapshot = {
      ...this.snapshot,
      camera,
      dirty: true,
      error: null,
      lastChangedAt: this.now(),
      lastLocalChangedAt: this.now(),
      lastSource: "local",
      liveView: camera,
      localVersion: this.snapshot.localVersion + 1,
      version: this.snapshot.version + 1,
    };
    this.notify();
    this.scheduleIdleFlush();
    return true;
  }

  flushDue(reason: CameraRegistryFlushReason = "manual"): Promise<void> {
    if (this.interactionActive) {
      this.setPendingFlushReason(reason);
      return Promise.resolve();
    }
    if (!this.snapshot.dirty) {
      return Promise.resolve();
    }
    if (
      this.snapshot.remoteCamera &&
      cameraStatesEqual(this.snapshot.camera, this.snapshot.remoteCamera)
    ) {
      this.localDirty = false;
      this.setSnapshotIfChanged({
        ...this.snapshot,
        dirty: false,
        error: null,
        pendingFlushReason: null,
      });
      return Promise.resolve();
    }

    return this.flushNow(reason);
  }

  flushNow(reason: CameraRegistryFlushReason = "manual"): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (!this.snapshot.dirty) return Promise.resolve();

    const camera = cloneCameraState(this.snapshot.camera);
    this.clearIdleFlushTimer();
    this.inflightCameraInvalidationSuppressed = false;
    this.snapshot = {
      ...this.snapshot,
      error: null,
      inflightCamera: camera,
      pendingFlushReason: reason,
      syncInFlight: true,
      version: this.snapshot.version + 1,
    };
    this.notify();

    this.flushPromise = this.api
      .patch({ camera: cameraStatePatch(camera) })
      .then((state) => {
        this.suppressedCameraInvalidationRevisions.add(
          resourceRevisionKey(state.revision),
        );
        this.applyRemoteState(state, "sync", this.now());
      })
      .catch((error: unknown) => {
        this.localDirty = true;
        this.snapshot = {
          ...this.snapshot,
          dirty: true,
          error: error instanceof Error ? error : new Error(String(error)),
          inflightCamera: null,
          pendingFlushReason: reason,
          syncInFlight: false,
          version: this.snapshot.version + 1,
        };
        this.notify();
        this.scheduleIdleFlush();
      })
      .finally(() => {
        this.flushPromise = null;
        if (!this.snapshot.inflightCamera && !this.snapshot.syncInFlight) return;
        this.snapshot = {
          ...this.snapshot,
          inflightCamera: null,
          pendingFlushReason: this.snapshot.dirty
            ? this.snapshot.pendingFlushReason
            : null,
          syncInFlight: false,
          version: this.snapshot.version + 1,
        };
        this.notify();
      });

    return this.flushPromise;
  }

  shouldSuppressInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
  ): boolean {
    if (resourceKey !== VISUALIZATION_STATE_PATH) return false;
    if (
      !this.inflightCameraInvalidationSuppressed &&
      this.snapshot.inflightCamera
    ) {
      this.inflightCameraInvalidationSuppressed = true;
      return true;
    }
    const key = resourceRevisionKey(revision);
    if (!this.suppressedCameraInvalidationRevisions.has(key)) return false;
    this.suppressedCameraInvalidationRevisions.delete(key);
    return true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.documentTarget?.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.windowTarget?.addEventListener("pagehide", this.handlePageHide);
    if (this.snapshot.dirty) {
      this.scheduleIdleFlush();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearIdleFlushTimer();
    this.documentTarget?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.windowTarget?.removeEventListener("pagehide", this.handlePageHide);
  }

  subscribe(listener: CameraRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setSnapshotIfChanged(next: Omit<CameraRegistrySnapshot, "version">): void {
    if (
      cameraStatesEqual(this.snapshot.camera, next.camera) &&
      this.snapshot.dirty === next.dirty &&
      this.snapshot.error === next.error &&
      cameraStatesEqualNullable(this.snapshot.inflightCamera, next.inflightCamera) &&
      this.snapshot.lastChangedAt === next.lastChangedAt &&
      this.snapshot.lastLocalChangedAt === next.lastLocalChangedAt &&
      this.snapshot.lastRemoteRevision === next.lastRemoteRevision &&
      this.snapshot.lastSource === next.lastSource &&
      this.snapshot.lastSyncedAt === next.lastSyncedAt &&
      cameraStatesEqual(this.snapshot.liveView, next.liveView) &&
      this.snapshot.localVersion === next.localVersion &&
      this.snapshot.pendingFlushReason === next.pendingFlushReason &&
      cameraStatesEqualNullable(this.snapshot.persistedShadow, next.persistedShadow) &&
      this.snapshot.persistedVersion === next.persistedVersion &&
      cameraStatesEqualNullable(this.snapshot.remoteCamera, next.remoteCamera) &&
      this.snapshot.syncInFlight === next.syncInFlight
    ) {
      return;
    }

    this.snapshot = {
      ...next,
      version: this.snapshot.version + 1,
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private clearIdleFlushTimer(): void {
    if (this.idleFlushId === null) return;
    clearTimeout(this.idleFlushId);
    this.idleFlushId = null;
  }

  private isDocumentVisible(): boolean {
    return this.documentTarget?.visibilityState !== "hidden";
  }

  private scheduleIdleFlush(): void {
    if (!this.started || this.idleFlushMs === null) return;
    this.clearIdleFlushTimer();
    this.setPendingFlushReason("idle");
    this.idleFlushId = setTimeout(() => {
      this.idleFlushId = null;
      void this.flushDue("idle");
    }, this.idleFlushMs);
  }

  private setPendingFlushReason(reason: CameraRegistryFlushReason): void {
    if (this.snapshot.pendingFlushReason === reason) return;
    this.snapshot = {
      ...this.snapshot,
      pendingFlushReason: reason,
      version: this.snapshot.version + 1,
    };
    this.notify();
  }
}

function applyCameraPatch(
  base: CameraRegistryCameraState,
  patch: CameraPatch,
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
    next.position = vector3OrFallback(patch.position, next.position);
  }
  if ("target" in patch) {
    next.target = vector3OrFallback(patch.target, next.target);
  }
  if ("up" in patch) {
    next.up = vector3OrFallback(patch.up, next.up);
  }
  return next;
}

function cameraStatePatch(camera: CameraRegistryCameraState): CameraPatch {
  return {
    fov_degrees: camera.fov_degrees,
    orthographic_scale: camera.orthographic_scale ?? null,
    position: [...camera.position],
    projection: camera.projection,
    target: [...camera.target],
    up: [...camera.up],
  };
}

function cameraStatesEqual(
  left: CameraRegistryCameraState,
  right: CameraRegistryCameraState,
): boolean {
  return cameraStateSignature(left) === cameraStateSignature(right);
}

function cameraStatesEqualNullable(
  left: CameraRegistryCameraState | null,
  right: CameraRegistryCameraState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return cameraStatesEqual(left, right);
}

function cloneCameraState(
  camera: CameraRegistryCameraState,
): CameraRegistryCameraState {
  return {
    fov_degrees: camera.fov_degrees,
    orthographic_scale: camera.orthographic_scale ?? null,
    position: vector3OrFallback(camera.position, DEFAULT_CAMERA_REGISTRY_STATE.position),
    projection:
      camera.projection === "orthographic" ? "orthographic" : "perspective",
    target: vector3OrFallback(camera.target, DEFAULT_CAMERA_REGISTRY_STATE.target),
    up: vector3OrFallback(camera.up, DEFAULT_CAMERA_REGISTRY_STATE.up),
  };
}

function hasCameraPatchKeys(patch: CameraPatch): boolean {
  return Object.keys(patch).length > 0;
}

function normalizeCameraState(
  camera: CameraRegistryCameraState,
): CameraRegistryCameraState {
  return applyCameraPatch(DEFAULT_CAMERA_REGISTRY_STATE, camera);
}

const CAMERA_VECTOR_SIGNATURE_EPSILON = 1e-12;
const CAMERA_SCALAR_SIGNATURE_EPSILON = 1e-6;

function cameraStateSignature(camera: CameraRegistryCameraState): string {
  const normalized = cloneCameraState(camera);
  return [
    normalized.projection,
    quantizeForSignature(normalized.fov_degrees, CAMERA_SCALAR_SIGNATURE_EPSILON),
    normalized.orthographic_scale == null
      ? "null"
      : quantizeForSignature(
          normalized.orthographic_scale,
          CAMERA_VECTOR_SIGNATURE_EPSILON,
        ),
    vectorSignature(normalized.position),
    vectorSignature(normalized.target),
    vectorSignature(normalized.up),
  ].join("|");
}

function quantizeForSignature(value: number, epsilon: number): string {
  return String(Math.round(value / epsilon));
}

function resourceRevisionKey(revision: ResourceRevision): string {
  return `${typeof revision}:${String(revision)}`;
}

function isOlderNumericRevision(
  next: ResourceRevision,
  current: ResourceRevision | null,
): boolean {
  return (
    typeof next === "number" &&
    typeof current === "number" &&
    next < current
  );
}

function vector3OrFallback(
  value: readonly number[] | null | undefined,
  fallback: readonly number[],
): number[] {
  if (!value || value.length < 3) return [...fallback];
  const next = [Number(value[0]), Number(value[1]), Number(value[2])];
  return next.every(Number.isFinite) ? next : [...fallback];
}

function vectorSignature(value: readonly number[]): string {
  return value
    .map((component) =>
      quantizeForSignature(component, CAMERA_VECTOR_SIGNATURE_EPSILON),
    )
    .join(":");
}
