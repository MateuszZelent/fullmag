import type {
  RequestOptions,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import type { ResourceRevision } from "../api/apiTypes";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { sharedResourceRuntimeStore } from "../resources/ResourceRuntimeStore";
import { mergeVisualizationStateTargetOverrides } from "./ObjectVisualizationController";

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
  inflightTargetIds: readonly string[];
  lastLocalChangedAt: number | null;
  lastRemoteRevision: ResourceRevision | null;
  mutation: VisualizationRegistryMutationState | null;
  pendingFingerprint: string | null;
  pendingPatch: VisualizationStatePatch | null;
  pendingTargetIds: readonly string[];
  version: number;
}

export interface VisualizationRegistryMutationState {
  attempts: number;
  error: string | null;
  requestId: string | null;
  status: "inflight" | "rejected" | "retrying" | "succeeded";
  targetId: string;
}

interface VisualizationRegistrySyncControllerOptions {
  api: VisualizationRegistrySyncApi;
  maxLatencyMs?: number;
  now?: () => number;
  quietMs?: number;
  maxTransientAttempts?: number;
  retryBaseDelayMs?: number;
  resources?: Pick<ResourceInvalidationController, "invalidate">;
}

const DEFAULT_MAX_LATENCY_MS = 2_500;
const DEFAULT_QUIET_MS = 600;
const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const EMPTY_TARGET_IDS: readonly string[] = [];

const INITIAL_SNAPSHOT: VisualizationRegistrySyncSnapshot = {
  error: null,
  inflightPatch: null,
  inflightTargetIds: EMPTY_TARGET_IDS,
  lastLocalChangedAt: null,
  lastRemoteRevision: null,
  mutation: null,
  pendingFingerprint: null,
  pendingPatch: null,
  pendingTargetIds: EMPTY_TARGET_IDS,
  version: 0,
};

export class VisualizationRegistrySyncController {
  private readonly api: VisualizationRegistrySyncApi;
  private readonly listeners = new Set<VisualizationRegistrySyncListener>();
  private readonly maxLatencyMs: number;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly maxTransientAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly resources: Pick<ResourceInvalidationController, "invalidate"> | null;
  private firstPendingAt: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private inflightCameraInvalidationSuppressed = false;
  private rejectedPatch: VisualizationStatePatch | null = null;
  private rejectedTargetIds: readonly string[] = EMPTY_TARGET_IDS;
  private started = false;
  private readonly suppressedCameraInvalidationRevisions = new Set<string>();
  private snapshot: VisualizationRegistrySyncSnapshot = INITIAL_SNAPSHOT;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor({
    api,
    maxLatencyMs = DEFAULT_MAX_LATENCY_MS,
    now = Date.now,
    quietMs = DEFAULT_QUIET_MS,
    maxTransientAttempts = DEFAULT_MAX_TRANSIENT_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    resources,
  }: VisualizationRegistrySyncControllerOptions) {
    this.api = api;
    this.maxLatencyMs = maxLatencyMs;
    this.now = now;
    this.quietMs = quietMs;
    this.maxTransientAttempts = Math.max(1, Math.trunc(maxTransientAttempts));
    this.retryBaseDelayMs = Math.max(0, retryBaseDelayMs);
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
      inflightTargetIds: mergeTargetIds(
        this.snapshot.inflightTargetIds,
        this.snapshot.pendingTargetIds,
      ),
      pendingFingerprint: null,
      pendingPatch: null,
      pendingTargetIds: EMPTY_TARGET_IDS,
      mutation: {
        attempts: 0,
        error: null,
        requestId: null,
        status: "inflight",
        targetId: visualizationPatchTargetId(patch),
      },
      version: this.snapshot.version + 1,
    };
    this.firstPendingAt = null;
    if (renderAffectingPatch) {
      this.notify();
    }

    this.flushPromise = this.patchWithBoundedRetry(patch)
      .then((state) => {
        this.rejectedPatch = null;
        this.rejectedTargetIds = EMPTY_TARGET_IDS;
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
        this.snapshot = {
          ...this.snapshot,
          mutation: this.snapshot.mutation
            ? { ...this.snapshot.mutation, status: "succeeded" }
            : null,
          version: this.snapshot.version + 1,
        };
      })
      .catch((error: unknown) => {
        this.rejectedPatch = patch;
        this.rejectedTargetIds = this.snapshot.inflightTargetIds;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.snapshot = {
          ...this.snapshot,
          error: normalizedError,
          inflightPatch: null,
          inflightTargetIds: EMPTY_TARGET_IDS,
          pendingFingerprint: null,
          pendingPatch: null,
          pendingTargetIds: EMPTY_TARGET_IDS,
          mutation: this.snapshot.mutation
            ? {
                ...this.snapshot.mutation,
                error: normalizedError.message,
                requestId: requestIdFromError(error),
                status: "rejected",
              }
            : null,
          version: this.snapshot.version + 1,
        };
        this.firstPendingAt = null;
        if (renderAffectingPatch) {
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

  private async patchWithBoundedRetry(
    patch: VisualizationStatePatch,
  ): Promise<VisualizationStateResource> {
    for (let attempt = 1; attempt <= this.maxTransientAttempts; attempt += 1) {
      this.snapshot = {
        ...this.snapshot,
        mutation: this.snapshot.mutation
          ? {
              ...this.snapshot.mutation,
              attempts: attempt,
              status: attempt === 1 ? "inflight" : "retrying",
            }
          : null,
        version: this.snapshot.version + 1,
      };
      try {
        return await this.api.patch(patch);
      } catch (error) {
        if (!isTransientVisualizationPatchError(error) || attempt >= this.maxTransientAttempts) {
          throw error;
        }
        await delay(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new Error("Visualization patch retry limit exhausted");
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
    const pendingTargetIds = pendingPatch
      ? this.snapshot.pendingTargetIds
      : EMPTY_TARGET_IDS;
    const inflightTargetIds = inflightPatch
      ? this.snapshot.inflightTargetIds
      : EMPTY_TARGET_IDS;
    if (
      this.snapshot.lastRemoteRevision === state.revision &&
      this.snapshot.pendingPatch === pendingPatch &&
      this.snapshot.inflightPatch === inflightPatch &&
      this.snapshot.pendingTargetIds === pendingTargetIds &&
      this.snapshot.inflightTargetIds === inflightTargetIds
    ) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      inflightPatch,
      inflightTargetIds,
      lastRemoteRevision: state.revision,
      pendingFingerprint: null,
      pendingPatch,
      pendingTargetIds,
      version: this.snapshot.version + 1,
    };
    if (!pendingPatch) {
      this.firstPendingAt = null;
    }
    if (snapshotChangeAffectsRender(previousSnapshot, this.snapshot)) {
      this.notify();
    }
  }

  queuePatch(
    patch: VisualizationStatePatch,
    targetIds: readonly string[] = [],
  ): void {
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
    const pendingTargetIds = mergeTargetIds(
      this.snapshot.pendingTargetIds,
      targetIds.length > 0 ? targetIds : targetIdsFromPatch(patch),
    );

    this.firstPendingAt = this.firstPendingAt ?? now;
    this.snapshot = {
      ...this.snapshot,
      error: null,
      lastLocalChangedAt: now,
      pendingFingerprint: null,
      pendingPatch,
      pendingTargetIds,
      version: this.snapshot.version + 1,
    };
    if (!isCameraOnlyPatch(pendingPatch)) {
      this.notify();
    }
    this.scheduleFlush();
  }

  retryRejectedMutation(): Promise<void> {
    const patch = this.rejectedPatch;
    if (!patch || this.flushPromise) return Promise.resolve();
    const targetIds = this.rejectedTargetIds;
    this.rejectedTargetIds = EMPTY_TARGET_IDS;
    this.queuePatch(patch, targetIds);
    return this.flushNow();
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

function isTransientVisualizationPatchError(error: unknown): boolean {
  if (error instanceof ControlRoomApiError) {
    return error.status === 0 || error.status >= 500;
  }
  return !(error instanceof DOMException && error.name === "AbortError");
}

function requestIdFromError(error: unknown): string | null {
  return error instanceof ControlRoomApiError ? error.requestId : null;
}

function visualizationPatchTargetId(patch: VisualizationStatePatch): string {
  const target = patch.overrides?.[0];
  if (target?.scope_id) return `${target.scope}:${target.scope_id}`;
  return "visualization";
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    if (key === "overrides" && Array.isArray(previous) && Array.isArray(value)) {
      output[key] = mergeVisualizationStateTargetOverrides(
        previous as VisualizationStateResource["overrides"],
        value as VisualizationStateResource["overrides"],
      );
      continue;
    }
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

function mergeTargetIds(
  current: readonly string[],
  next: readonly string[],
): readonly string[] {
  return [...new Set([...current, ...next].filter((value) => value.length > 0))];
}

function targetIdsFromPatch(patch: VisualizationStatePatch): readonly string[] {
  if (!Array.isArray(patch.overrides)) return [];
  return mergeTargetIds(
    [],
    patch.overrides.flatMap((entry) => {
      if (!entry.scope || !entry.scope_id) return [];
      return [`${entry.scope}:${entry.scope_id}`];
    }),
  );
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
