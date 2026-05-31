import type {
  RequestOptions,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import type { ResourceRevision } from "../api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { sharedResourceRuntimeStore } from "../resources/ResourceRuntimeStore";

type VisualizationRegistrySyncListener = () => void;

interface VisualizationRegistrySyncApi {
  patch: (
    patch: VisualizationStatePatch,
    options?: RequestOptions,
  ) => Promise<VisualizationStateResource>;
}

export interface VisualizationRegistrySyncSnapshot {
  error: Error | null;
  inflightPatch: VisualizationStatePatch | null;
  lastLocalChangedAt: number | null;
  lastRemoteRevision: ResourceRevision | null;
  pendingFingerprint: string | null;
  pendingPatch: VisualizationStatePatch | null;
  version: number;
}

interface VisualizationRegistrySyncControllerOptions {
  api: VisualizationRegistrySyncApi;
  maxLatencyMs?: number;
  now?: () => number;
  quietMs?: number;
  resources?: Pick<ResourceInvalidationController, "invalidate">;
}

const DEFAULT_MAX_LATENCY_MS = 2_500;
const DEFAULT_QUIET_MS = 600;

const INITIAL_SNAPSHOT: VisualizationRegistrySyncSnapshot = {
  error: null,
  inflightPatch: null,
  lastLocalChangedAt: null,
  lastRemoteRevision: null,
  pendingFingerprint: null,
  pendingPatch: null,
  version: 0,
};

export class VisualizationRegistrySyncController {
  private readonly api: VisualizationRegistrySyncApi;
  private readonly listeners = new Set<VisualizationRegistrySyncListener>();
  private readonly maxLatencyMs: number;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly resources: Pick<ResourceInvalidationController, "invalidate"> | null;
  private firstPendingAt: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private inflightCameraInvalidationSuppressed = false;
  private started = false;
  private readonly suppressedCameraInvalidationRevisions = new Set<string>();
  private snapshot: VisualizationRegistrySyncSnapshot = INITIAL_SNAPSHOT;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor({
    api,
    maxLatencyMs = DEFAULT_MAX_LATENCY_MS,
    now = Date.now,
    quietMs = DEFAULT_QUIET_MS,
    resources,
  }: VisualizationRegistrySyncControllerOptions) {
    this.api = api;
    this.maxLatencyMs = maxLatencyMs;
    this.now = now;
    this.quietMs = quietMs;
    this.resources = resources ?? null;
  }

  applyOptimisticState(
    remote: VisualizationStateResource | null | undefined,
  ): VisualizationStateResource | null {
    if (!remote) return null;
    const activePatch = this.activePatch();
    if (!activePatch) return remote;
    if (isCameraOnlyPatch(activePatch)) {
      const projectionPatch = cameraProjectionPatch(activePatch);
      return projectionPatch
        ? applyVisualizationStatePatch(remote, projectionPatch)
        : remote;
    }
    return applyVisualizationStatePatch(remote, activePatch);
  }

  flushDue(): Promise<void> {
    if (!this.snapshot.pendingPatch) {
      return Promise.resolve();
    }
    const elapsedSinceLastChange =
      this.snapshot.lastLocalChangedAt === null
        ? Number.POSITIVE_INFINITY
        : this.now() - this.snapshot.lastLocalChangedAt;
    const elapsedSinceFirstChange =
      this.firstPendingAt === null
        ? Number.POSITIVE_INFINITY
        : this.now() - this.firstPendingAt;

    if (
      elapsedSinceLastChange < this.quietMs &&
      elapsedSinceFirstChange < this.maxLatencyMs
    ) {
      this.scheduleFlush();
      return Promise.resolve();
    }

    this.clearScheduledFlush();
    return this.flushNow();
  }

  flushNow(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const patch = this.snapshot.pendingPatch;
    if (!patch) return Promise.resolve();
    const renderAffectingPatch = !isCameraOnlyPatch(patch);
    if (!renderAffectingPatch) {
      this.inflightCameraInvalidationSuppressed = false;
    }

    this.snapshot = {
      ...this.snapshot,
      error: null,
      inflightPatch: mergeVisualizationStatePatch(
        this.snapshot.inflightPatch,
        patch,
      ),
      pendingFingerprint: null,
      pendingPatch: null,
      version: this.snapshot.version + 1,
    };
    this.firstPendingAt = null;
    if (renderAffectingPatch) {
      this.notify();
    }

    this.flushPromise = this.api
      .patch(patch)
      .then((state) => {
        this.observeRemoteState(state);
        // Optimize: populate the local resource cache pessimistically with the fresh patched state
        // to avoid triggering a redundant GET /v2/sessions/current/visualization/state fetch.
        sharedResourceRuntimeStore.updateData(
          VISUALIZATION_STATE_PATH,
          state,
          state.revision,
        );

        if (renderAffectingPatch) {
          this.resources?.invalidate(
            VISUALIZATION_STATE_PATH,
            state.revision,
          );
        } else {
          this.suppressedCameraInvalidationRevisions.add(
            resourceRevisionKey(state.revision),
          );
        }
      })
      .catch((error: unknown) => {
        const restoredPatch = mergeVisualizationStatePatch(
          this.snapshot.inflightPatch,
          this.snapshot.pendingPatch,
        );
        const now = this.now();
        this.snapshot = {
          ...this.snapshot,
          error: error instanceof Error ? error : new Error(String(error)),
          inflightPatch: null,
          lastLocalChangedAt: now,
          pendingFingerprint: null,
          pendingPatch: restoredPatch,
          version: this.snapshot.version + 1,
        };
        this.firstPendingAt = this.firstPendingAt ?? now;
        if (!isCameraOnlyPatch(restoredPatch)) {
          this.notify();
        }
      })
      .finally(() => {
        if (!renderAffectingPatch) {
          this.inflightCameraInvalidationSuppressed = false;
        }
        this.flushPromise = null;
        this.scheduleFlush();
      });

    return this.flushPromise;
  }

  getSnapshot(): VisualizationRegistrySyncSnapshot {
    return this.snapshot;
  }

  hasUnsatisfiedCameraPatch(
    state: VisualizationStateResource | null | undefined,
  ): boolean {
    if (!state) return false;
    const activePatch = this.activePatch();
    if (!activePatch?.camera) return false;
    return !visualizationStateSatisfiesPatch(state, {
      camera: activePatch.camera,
    });
  }

  observeRemoteState(state: VisualizationStateResource | null | undefined): void {
    if (!state) return;
    const previousSnapshot = this.snapshot;

    const pendingPatch =
      this.snapshot.pendingPatch &&
      visualizationStateSatisfiesPatch(state, this.snapshot.pendingPatch)
        ? null
        : this.snapshot.pendingPatch;
    const inflightPatch =
      this.snapshot.inflightPatch &&
      visualizationStateSatisfiesPatch(state, this.snapshot.inflightPatch)
        ? null
        : this.snapshot.inflightPatch;
    if (
      this.snapshot.lastRemoteRevision === state.revision &&
      this.snapshot.pendingPatch === pendingPatch &&
      this.snapshot.inflightPatch === inflightPatch
    ) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      inflightPatch,
      lastRemoteRevision: state.revision,
      pendingFingerprint: null,
      pendingPatch,
      version: this.snapshot.version + 1,
    };
    if (!pendingPatch) {
      this.firstPendingAt = null;
    }
    if (snapshotChangeAffectsRender(previousSnapshot, this.snapshot)) {
      this.notify();
    }
  }

  queuePatch(patch: VisualizationStatePatch): void {
    if (!hasPatchKeys(patch)) return;
    if (
      this.snapshot.pendingPatch &&
      visualizationPatchSatisfiesPatch(this.snapshot.pendingPatch, patch)
    ) {
      return;
    }

    const now = this.now();
    const pendingPatch = mergeQueuedVisualizationPatch(
      this.snapshot.pendingPatch,
      patch,
    );

    this.firstPendingAt = this.firstPendingAt ?? now;
    this.snapshot = {
      ...this.snapshot,
      error: null,
      lastLocalChangedAt: now,
      pendingFingerprint: null,
      pendingPatch,
      version: this.snapshot.version + 1,
    };
    if (!isCameraOnlyPatch(pendingPatch)) {
      this.notify();
    }
    this.scheduleFlush();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleFlush();
  }

  shouldSuppressInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
  ): boolean {
    if (resourceKey !== VISUALIZATION_STATE_PATH) return false;
    if (
      !this.inflightCameraInvalidationSuppressed &&
      this.snapshot.inflightPatch &&
      isCameraOnlyPatch(this.snapshot.inflightPatch)
    ) {
      this.inflightCameraInvalidationSuppressed = true;
      return true;
    }
    const key = resourceRevisionKey(revision);
    if (!this.suppressedCameraInvalidationRevisions.has(key)) return false;
    this.suppressedCameraInvalidationRevisions.delete(key);
    return true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearScheduledFlush();
  }

  subscribe(listener: VisualizationRegistrySyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private activePatch(): VisualizationStatePatch | null {
    return mergeVisualizationStatePatch(
      this.snapshot.inflightPatch,
      this.snapshot.pendingPatch,
    );
  }

  private clearScheduledFlush(): void {
    if (this.timeoutId === null) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  private scheduleFlush(): void {
    if (!this.started || this.timeoutId !== null || !this.snapshot.pendingPatch) {
      return;
    }

    const elapsedSinceLastChange =
      this.snapshot.lastLocalChangedAt === null
        ? Number.POSITIVE_INFINITY
        : this.now() - this.snapshot.lastLocalChangedAt;
    const elapsedSinceFirstChange =
      this.firstPendingAt === null
        ? Number.POSITIVE_INFINITY
        : this.now() - this.firstPendingAt;
    const quietDelay = Math.max(0, this.quietMs - elapsedSinceLastChange);
    const latencyDelay = Math.max(0, this.maxLatencyMs - elapsedSinceFirstChange);
    const delay = Math.min(quietDelay, latencyDelay);

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.flushDue();
    }, delay);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function resourceRevisionKey(revision: ResourceRevision): string {
  return `${typeof revision}:${String(revision)}`;
}

function snapshotChangeAffectsRender(
  previous: VisualizationRegistrySyncSnapshot,
  next: VisualizationRegistrySyncSnapshot,
): boolean {
  if (previous.error !== next.error) return true;
  return (
    !isCameraOnlyPatch(previous.pendingPatch) ||
    !isCameraOnlyPatch(previous.inflightPatch) ||
    !isCameraOnlyPatch(next.pendingPatch) ||
    !isCameraOnlyPatch(next.inflightPatch)
  );
}

function applyVisualizationStatePatch<TState>(
  state: TState,
  patch: VisualizationStatePatch | null | undefined,
): TState {
  if (!patch || !hasPatchKeys(patch)) return state;
  if (!isPlainObject(state)) return patch as TState;
  return mergeQueuedPatchRecords(
    state,
    patch as Record<string, unknown>,
  ) as TState;
}

function mergeQueuedVisualizationPatch(
  current: VisualizationStatePatch | null | undefined,
  next: VisualizationStatePatch | null | undefined,
): VisualizationStatePatch | null {
  if (!current && !next) return null;
  if (!current) return next ?? null;
  if (!next) return current;
  return mergeQueuedPatchRecords(
    current as Record<string, unknown>,
    next as Record<string, unknown>,
  ) as VisualizationStatePatch;
}

function mergeQueuedPatchRecords(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    const previous = output[key];
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeQueuedPatchRecords(previous, value)
        : value;
  }
  return output;
}

function mergeVisualizationStatePatch(
  current: VisualizationStatePatch | null | undefined,
  next: VisualizationStatePatch | null | undefined,
): VisualizationStatePatch | null {
  if (!current && !next) return null;
  if (!current) return next ?? null;
  if (!next) return current;
  return mergeQueuedPatchRecords(
    current as Record<string, unknown>,
    next as Record<string, unknown>,
  ) as VisualizationStatePatch;
}

function visualizationStateSatisfiesPatch(
  state: VisualizationStateResource,
  patch: VisualizationStatePatch,
): boolean {
  return Object.entries(patch).every(([key, patchValue]) =>
    valueSatisfiesPatch(
      (state as Record<string, unknown>)[key],
      patchValue,
    ),
  );
}

function visualizationPatchSatisfiesPatch(
  current: VisualizationStatePatch,
  patch: VisualizationStatePatch,
): boolean {
  return Object.entries(patch).every(([key, patchValue]) =>
    valueSatisfiesPatch(
      (current as Record<string, unknown>)[key],
      patchValue,
    ),
  );
}

function valueSatisfiesPatch(value: unknown, patch: unknown): boolean {
  if (Array.isArray(patch)) {
    if (!Array.isArray(value)) return false;
    return (
      patch.length === value.length &&
      patch.every((entry, index) => valueSatisfiesPatch(value[index], entry))
    );
  }
  if (isPlainObject(patch)) {
    if (!isPlainObject(value)) return false;
    return Object.entries(patch).every(([key, nestedPatch]) =>
      valueSatisfiesPatch(
        (value as Record<string, unknown>)[key],
        nestedPatch,
      ),
    );
  }
  return Object.is(value, patch);
}

function hasPatchKeys(patch: VisualizationStatePatch): boolean {
  return Object.keys(patch).length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function cameraProjectionPatch(
  patch: VisualizationStatePatch | null | undefined,
): VisualizationStatePatch | null {
  const projection = patch?.camera?.projection;
  if (projection !== "orthographic" && projection !== "perspective") {
    return null;
  }
  return { camera: { projection } };
}

function isCameraOnlyPatch(
  patch: VisualizationStatePatch | null | undefined,
): boolean {
  if (!patch) return true;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => key === "camera");
}
