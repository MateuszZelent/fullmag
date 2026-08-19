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
import {
  mergeVisualizationStateTargetOverrides,
  visualizationStateScopeIdForTarget,
  visualizationTargetKey,
  type VisualizationTargetRef,
} from "./ObjectVisualizationController";

type VisualizationRegistrySyncListener = () => void;
type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarTargetOverride = NonNullable<PlanarState["target_overrides"]>[number];
type PlanarWireframeStyle = PlanarState["wireframe_style"];

export type PlanarTargetOverrideOperation =
  | {
      kind: "upsert";
      target: VisualizationTargetRef;
      wireframeStyle: PlanarWireframeStyle;
    }
  | {
      kind: "remove";
      target: VisualizationTargetRef;
    };

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
  inflightPlanarTargetIds: readonly string[];
  lastLocalChangedAt: number | null;
  lastRemoteRevision: ResourceRevision | null;
  mutation: VisualizationRegistryMutationState | null;
  pendingFingerprint: string | null;
  pendingPatch: VisualizationStatePatch | null;
  pendingTargetIds: readonly string[];
  pendingPlanarTargetIds: readonly string[];
  rejectedTargetIds: readonly string[];
  rejectedPlanarTargetIds: readonly string[];
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
  onRejectedTargetPatches?: (targetIds: readonly string[]) => void;
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
  inflightPlanarTargetIds: EMPTY_TARGET_IDS,
  lastLocalChangedAt: null,
  lastRemoteRevision: null,
  mutation: null,
  pendingFingerprint: null,
  pendingPatch: null,
  pendingTargetIds: EMPTY_TARGET_IDS,
  rejectedTargetIds: EMPTY_TARGET_IDS,
  pendingPlanarTargetIds: EMPTY_TARGET_IDS,
  version: 0,
  rejectedPlanarTargetIds: EMPTY_TARGET_IDS,
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
  private readonly onRejectedTargetPatches:
    | ((targetIds: readonly string[]) => void)
    | null;
  private firstPendingAt: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private inflightCameraInvalidationSuppressed = false;
  private remoteState: VisualizationStateResource | null = null;
  private rejectedPatch: VisualizationStatePatch | null = null;
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
    onRejectedTargetPatches,
  }: VisualizationRegistrySyncControllerOptions) {
    this.api = api;
    this.maxLatencyMs = maxLatencyMs;
    this.now = now;
    this.quietMs = quietMs;
    this.maxTransientAttempts = Math.max(1, Math.trunc(maxTransientAttempts));
    this.retryBaseDelayMs = Math.max(0, retryBaseDelayMs);
    this.resources = resources ?? null;
    this.onRejectedTargetPatches = onRejectedTargetPatches ?? null;
  }

  applyOptimisticState(
    remote: VisualizationStateResource | null | undefined,
  ): VisualizationStateResource | null {
    if (!remote) return null;
    let optimistic = remote;
    const activePatches = [
      {
        patch: this.snapshot.inflightPatch,
        planarTargetIds: this.snapshot.inflightPlanarTargetIds,
        targetIds: this.snapshot.inflightTargetIds,
      },
      {
        patch: this.snapshot.pendingPatch,
        planarTargetIds: this.snapshot.pendingPlanarTargetIds,
        targetIds: this.snapshot.pendingTargetIds,
      },
    ];
    for (const { patch, planarTargetIds, targetIds } of activePatches) {
      if (!patch) continue;
      if (isCameraOnlyPatch(patch)) {
        const projectionPatch = cameraProjectionPatch(patch);
        if (projectionPatch) {
          optimistic = applyVisualizationStatePatch(
            optimistic,
            projectionPatch,
          );
        }
        continue;
      }
      optimistic = applyVisualizationStatePatch(
        optimistic,
        patch,
        targetIds,
        planarTargetIds,
      );
    }
    return optimistic;
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
    const targetIds = this.snapshot.pendingTargetIds;
    const planarTargetIds = this.snapshot.pendingPlanarTargetIds;
    const requestPatch = rebaseVisualizationStatePatch(
      this.remoteState,
      patch,
      targetIds,
      planarTargetIds,
    );
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
      inflightPlanarTargetIds: mergeTargetIds(
        this.snapshot.inflightPlanarTargetIds,
        this.snapshot.pendingPlanarTargetIds,
      ),
      pendingFingerprint: null,
      pendingPatch: null,
      pendingTargetIds: EMPTY_TARGET_IDS,
      pendingPlanarTargetIds: EMPTY_TARGET_IDS,
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

    this.flushPromise = this.patchWithBoundedRetry(requestPatch)
      .then((state) => {
        this.rejectedPatch = null;
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
          rejectedTargetIds: EMPTY_TARGET_IDS,
          version: this.snapshot.version + 1,
          rejectedPlanarTargetIds: EMPTY_TARGET_IDS,
        };
      })
      .catch((error: unknown) => {
        this.rejectedPatch = patch;
        const rejectedTargetIds = targetIds;
        const rejectedPlanarTargetIds = planarTargetIds;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.snapshot = {
          ...this.snapshot,
          error: normalizedError,
          inflightPatch: null,
          inflightTargetIds: EMPTY_TARGET_IDS,
          inflightPlanarTargetIds: EMPTY_TARGET_IDS,
          pendingFingerprint: null,
          pendingPatch: null,
          pendingTargetIds: EMPTY_TARGET_IDS,
          rejectedTargetIds,
          pendingPlanarTargetIds: EMPTY_TARGET_IDS,
          rejectedPlanarTargetIds,
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
        this.onRejectedTargetPatches?.(rejectedTargetIds);
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
    this.remoteState = state;
    const previousSnapshot = this.snapshot;

    const pendingPatch =
      this.snapshot.pendingPatch &&
      visualizationStateSatisfiesPatch(
        state,
        this.snapshot.pendingPatch,
        this.snapshot.pendingTargetIds,
        this.snapshot.pendingPlanarTargetIds,
      )
        ? null
        : this.snapshot.pendingPatch;
    const inflightPatch =
      this.snapshot.inflightPatch &&
      visualizationStateSatisfiesPatch(
        state,
        this.snapshot.inflightPatch,
        this.snapshot.inflightTargetIds,
        this.snapshot.inflightPlanarTargetIds,
      )
        ? null
        : this.snapshot.inflightPatch;
    const pendingTargetIds = pendingPatch
      ? this.snapshot.pendingTargetIds
      : EMPTY_TARGET_IDS;
    const pendingPlanarTargetIds = pendingPatch
      ? this.snapshot.pendingPlanarTargetIds
      : EMPTY_TARGET_IDS;
    const inflightTargetIds = inflightPatch
      ? this.snapshot.inflightTargetIds
      : EMPTY_TARGET_IDS;
    const inflightPlanarTargetIds = inflightPatch
      ? this.snapshot.inflightPlanarTargetIds
      : EMPTY_TARGET_IDS;
    if (
      this.snapshot.lastRemoteRevision === state.revision &&
      this.snapshot.pendingPatch === pendingPatch &&
      this.snapshot.inflightPatch === inflightPatch &&
      this.snapshot.pendingTargetIds === pendingTargetIds &&
      this.snapshot.pendingPlanarTargetIds === pendingPlanarTargetIds &&
      this.snapshot.inflightTargetIds === inflightTargetIds &&
      this.snapshot.inflightPlanarTargetIds === inflightPlanarTargetIds
    ) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      inflightPatch,
      inflightTargetIds,
      inflightPlanarTargetIds,
      lastRemoteRevision: state.revision,
      pendingFingerprint: null,
      pendingPatch,
      pendingTargetIds,
      pendingPlanarTargetIds,
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
    this.queuePatchForChannels(patch, targetIds, EMPTY_TARGET_IDS);
  }

  queuePlanarTargetOverride(operation: PlanarTargetOverrideOperation): void {
    if (
      operation.target.kind !== "airbox" &&
      operation.target.kind !== "object" &&
      operation.target.kind !== "part"
    ) {
      return;
    }
    const targetId = visualizationTargetKey(operation.target);
    const targetOverrides: PlanarTargetOverride[] =
      operation.kind === "upsert"
        ? [
            {
              scope: operation.target.kind,
              scope_id: visualizationStateScopeIdForTarget(operation.target),
              wireframe_style: operation.wireframeStyle,
            },
          ]
        : [];
    this.queuePatchForChannels(
      { planar: { target_overrides: targetOverrides } },
      EMPTY_TARGET_IDS,
      [targetId],
    );
  }

  private queuePatchForChannels(
    patch: VisualizationStatePatch,
    targetIds: readonly string[],
    planarTargetIds: readonly string[],
  ): void {
    if (!hasPatchKeys(patch)) return;
    const effectiveTargetIds = normalizeTargetIds(
      targetIds.length > 0 ? targetIds : targetIdsFromPatch(patch),
    );
    const effectivePlanarTargetIds = normalizeTargetIds(planarTargetIds);
    if (
      this.snapshot.pendingPatch &&
      visualizationPatchSatisfiesPatch(
        this.snapshot.pendingPatch,
        patch,
        this.snapshot.pendingTargetIds,
        effectiveTargetIds,
        this.snapshot.pendingPlanarTargetIds,
        effectivePlanarTargetIds,
      )
    ) {
      return;
    }

    const now = this.now();
    const pendingPatch = mergeQueuedVisualizationPatch(
      this.snapshot.pendingPatch,
      patch,
      effectiveTargetIds,
      effectivePlanarTargetIds,
    );
    const pendingTargetIds = mergeTargetIds(
      this.snapshot.pendingTargetIds,
      effectiveTargetIds,
    );
    const pendingPlanarTargetIds = mergeTargetIds(
      this.snapshot.pendingPlanarTargetIds,
      effectivePlanarTargetIds,
    );

    this.firstPendingAt = this.firstPendingAt ?? now;
    this.snapshot = {
      ...this.snapshot,
      error: null,
      lastLocalChangedAt: now,
      pendingFingerprint: null,
      pendingPatch,
      pendingTargetIds,
      pendingPlanarTargetIds,
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
    const targetIds = this.snapshot.rejectedTargetIds;
    const planarTargetIds = this.snapshot.rejectedPlanarTargetIds;
    this.snapshot = {
      ...this.snapshot,
      rejectedTargetIds: EMPTY_TARGET_IDS,
      rejectedPlanarTargetIds: EMPTY_TARGET_IDS,
      version: this.snapshot.version + 1,
    };
    this.queuePatchForChannels(patch, targetIds, planarTargetIds);
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
  if (target?.scope_id) return visualizationOverrideTargetId(target);
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
  targetIds: readonly string[] = EMPTY_TARGET_IDS,
  planarTargetIds: readonly string[] = EMPTY_TARGET_IDS,
): TState {
  if (!patch || !hasPatchKeys(patch)) return state;
  if (!isPlainObject(state)) return patch as TState;
  return mergeQueuedPatchRecords(
    state,
    patch as Record<string, unknown>,
    targetIds,
    planarTargetIds,
  ) as TState;
}

function mergeQueuedVisualizationPatch(
  current: VisualizationStatePatch | null | undefined,
  next: VisualizationStatePatch | null | undefined,
  targetIds: readonly string[] = EMPTY_TARGET_IDS,
  planarTargetIds: readonly string[] = EMPTY_TARGET_IDS,
): VisualizationStatePatch | null {
  if (!current && !next) return null;
  if (!current) return next ?? null;
  if (!next) return current;
  return mergeQueuedPatchRecords(
    current as Record<string, unknown>,
    next as Record<string, unknown>,
    targetIds,
    planarTargetIds,
  ) as VisualizationStatePatch;
}

function rebaseVisualizationStatePatch(
  remote: VisualizationStateResource | null,
  patch: VisualizationStatePatch,
  targetIds: readonly string[],
  planarTargetIds: readonly string[],
): VisualizationStatePatch {
  const planarPatch = patch.planar;
  const hasTargetOverrides = Array.isArray(patch.overrides);
  const hasPlanarTargetOverrides = Array.isArray(
    planarPatch?.target_overrides,
  );
  if (
    !remote ||
    ((!hasTargetOverrides || targetIds.length === 0) &&
      (!hasPlanarTargetOverrides || planarTargetIds.length === 0))
  ) {
    return patch;
  }

  const rebased = applyVisualizationStatePatch(
    remote,
    patch,
    targetIds,
    planarTargetIds,
  );
  return {
    ...patch,
    ...(hasTargetOverrides ? { overrides: rebased.overrides } : {}),
    ...(hasPlanarTargetOverrides
      ? {
          planar: {
            ...planarPatch,
            target_overrides: rebased.planar?.target_overrides ?? [],
          },
        }
      : {}),
  };
}

function mergeQueuedPatchRecords(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  targetIds: readonly string[] = EMPTY_TARGET_IDS,
  planarTargetIds: readonly string[] = EMPTY_TARGET_IDS,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    const previous = output[key];
    if (key === "overrides" && Array.isArray(previous) && Array.isArray(value)) {
      output[key] = mergeQueuedTargetOverrides(
        previous as VisualizationStateResource["overrides"],
        value as VisualizationStateResource["overrides"],
        targetIds,
      );
      continue;
    }
    if (
      key === "target_overrides" &&
      planarTargetIds.length > 0 &&
      Array.isArray(previous) &&
      Array.isArray(value)
    ) {
      output[key] = mergeQueuedPlanarTargetOverrides(
        previous as PlanarTargetOverride[],
        value as PlanarTargetOverride[],
        planarTargetIds,
      );
      continue;
    }
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeQueuedPatchRecords(previous, value, targetIds, planarTargetIds)
        : value;
  }
  return output;
}

function mergeQueuedPlanarTargetOverrides(
  current: readonly PlanarTargetOverride[],
  next: readonly PlanarTargetOverride[],
  targetIds: readonly string[],
): PlanarTargetOverride[] {
  const targeted = new Set(normalizeTargetIds(targetIds));
  const currentByIdentity = new Map(
    current.map((entry) => [planarTargetOverrideIdentity(entry), entry]),
  );
  const nextByIdentity = new Map(
    next.map((entry) => [planarTargetOverrideIdentity(entry), entry]),
  );
  const result: PlanarTargetOverride[] = [];

  for (const entry of current) {
    const identity = planarTargetOverrideIdentity(entry);
    if (!targeted.has(planarTargetOverrideTargetId(entry))) {
      result.push(entry);
      continue;
    }
    const replacement = nextByIdentity.get(identity);
    if (replacement) result.push(replacement);
  }

  for (const entry of next) {
    const identity = planarTargetOverrideIdentity(entry);
    if (
      !currentByIdentity.has(identity) &&
      targeted.has(planarTargetOverrideTargetId(entry))
    ) {
      result.push(entry);
    }
  }
  return result;
}

function planarTargetOverrideIdentity(entry: PlanarTargetOverride): string {
  return `${entry.scope}:${entry.scope_id}`;
}

function planarTargetOverrideTargetId(entry: PlanarTargetOverride): string {
  if (entry.scope === "airbox") return "airbox";
  if (entry.scope === "object" || entry.scope === "part") {
    return entry.scope_id.startsWith(`${entry.scope}:`)
      ? entry.scope_id
      : `${entry.scope}:${entry.scope_id}`;
  }
  return `${entry.scope}:${entry.scope_id}`;
}

function mergeQueuedTargetOverrides(
  current: VisualizationStateResource["overrides"],
  next: VisualizationStateResource["overrides"],
  targetIds: readonly string[],
): VisualizationStateResource["overrides"] {
  if (targetIds.length === 0) {
    return mergeVisualizationStateTargetOverrides(current, next);
  }

  const targeted = new Set(targetIds);
  const currentByIdentity = new Map(
    current.map((entry) => [visualizationStateOverrideIdentity(entry), entry]),
  );
  const nextByIdentity = new Map(
    next.map((entry) => [visualizationStateOverrideIdentity(entry), entry]),
  );
  const result: VisualizationStateResource["overrides"] = [];

  for (const entry of current) {
    const identity = visualizationStateOverrideIdentity(entry);
    if (!targeted.has(visualizationOverrideTargetId(entry))) {
      result.push(entry);
      continue;
    }
    const replacement = nextByIdentity.get(identity);
    if (replacement) {
      result.push(
        ...mergeVisualizationStateTargetOverrides([entry], [replacement]),
      );
    }
  }

  for (const entry of next) {
    const identity = visualizationStateOverrideIdentity(entry);
    if (
      !currentByIdentity.has(identity) &&
      targeted.has(visualizationOverrideTargetId(entry))
    ) {
      result.push(entry);
    }
  }

  return result;
}

function visualizationStateOverrideIdentity(
  entry: VisualizationStateResource["overrides"][number],
): string {
  return `${entry.scope}:${entry.scope_id}`;
}

function visualizationOverrideTargetId(
  entry: VisualizationStateResource["overrides"][number],
): string {
  if (entry.scope === "fdm_domain" || entry.scope === "fdm_native_layer") {
    return entry.scope_id;
  }
  if (entry.scope === "airbox") return "airbox";
  if (entry.scope === "object") {
    return entry.scope_id.startsWith("object:")
      ? entry.scope_id
      : `object:${entry.scope_id}`;
  }
  if (entry.scope === "part") {
    return entry.scope_id.startsWith("part:")
      ? entry.scope_id
      : `part:${entry.scope_id}`;
  }
  if (entry.scope === "region") {
    return entry.scope_id.startsWith("region:")
      ? entry.scope_id
      : `region:${entry.scope_id}`;
  }
  return `${entry.scope}:${entry.scope_id}`;
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
  targetIds: readonly string[] = EMPTY_TARGET_IDS,
  planarTargetIds: readonly string[] = EMPTY_TARGET_IDS,
): boolean {
  return Object.entries(patch).every(([key, patchValue]) => {
    if (key === "overrides" && Array.isArray(patchValue) && targetIds.length > 0) {
      return targetOverridesSatisfyPatch(state.overrides, patchValue, targetIds);
    }
    if (key === "planar" && isPlainObject(patchValue) && planarTargetIds.length > 0) {
      return planarStateSatisfiesPatch(state.planar, patchValue, planarTargetIds);
    }
    return valueSatisfiesPatch(
      (state as Record<string, unknown>)[key],
      patchValue,
    );
  });
}

function visualizationPatchSatisfiesPatch(
  current: VisualizationStatePatch,
  patch: VisualizationStatePatch,
  currentTargetIds: readonly string[] = EMPTY_TARGET_IDS,
  targetIds: readonly string[] = EMPTY_TARGET_IDS,
  currentPlanarTargetIds: readonly string[] = EMPTY_TARGET_IDS,
  planarTargetIds: readonly string[] = EMPTY_TARGET_IDS,
): boolean {
  if (
    targetIds.length > 0 &&
    !normalizeTargetIds(targetIds).every((targetId) =>
      normalizeTargetIds(currentTargetIds).includes(targetId),
    )
  ) {
    return false;
  }
  if (
    planarTargetIds.length > 0 &&
    !normalizeTargetIds(planarTargetIds).every((targetId) =>
      normalizeTargetIds(currentPlanarTargetIds).includes(targetId),
    )
  ) {
    return false;
  }
  return Object.entries(patch).every(([key, patchValue]) => {
    if (key === "overrides" && Array.isArray(patchValue) && targetIds.length > 0) {
      return targetOverridesSatisfyPatch(
        Array.isArray(current.overrides) ? current.overrides : [],
        patchValue,
        targetIds,
      );
    }
    if (
      key === "planar" &&
      isPlainObject(patchValue) &&
      planarTargetIds.length > 0
    ) {
      return planarStateSatisfiesPatch(
        current.planar,
        patchValue,
        planarTargetIds,
      );
    }
    return valueSatisfiesPatch(
      (current as Record<string, unknown>)[key],
      patchValue,
    );
  });
}

function targetOverridesSatisfyPatch(
  current: readonly VisualizationStateResource["overrides"][number][],
  expected: readonly VisualizationStateResource["overrides"][number][],
  targetIds: readonly string[],
): boolean {
  return normalizeTargetIds(targetIds).every((targetId) => {
    const currentEntry = current.find(
      (entry) => visualizationOverrideTargetId(entry) === targetId,
    );
    const expectedEntry = expected.find(
      (entry) => visualizationOverrideTargetId(entry) === targetId,
    );
    return expectedEntry
      ? currentEntry !== undefined && valueSatisfiesPatch(currentEntry, expectedEntry)
      : currentEntry === undefined;
  });
}

function planarStateSatisfiesPatch(
  current: unknown,
  expected: Record<string, unknown>,
  targetIds: readonly string[],
): boolean {
  if (!isPlainObject(current)) return false;
  return Object.entries(expected).every(([key, patchValue]) => {
    if (
      key === "target_overrides" &&
      Array.isArray(patchValue) &&
      targetIds.length > 0
    ) {
      return planarTargetOverridesSatisfyPatch(
        Array.isArray(current.target_overrides)
          ? (current.target_overrides as PlanarTargetOverride[])
          : [],
        patchValue as PlanarTargetOverride[],
        targetIds,
      );
    }
    return valueSatisfiesPatch(current[key], patchValue);
  });
}

function planarTargetOverridesSatisfyPatch(
  current: readonly PlanarTargetOverride[],
  expected: readonly PlanarTargetOverride[],
  targetIds: readonly string[],
): boolean {
  return normalizeTargetIds(targetIds).every((targetId) => {
    const currentEntry = current.find(
      (entry) => planarTargetOverrideTargetId(entry) === targetId,
    );
    const expectedEntry = expected.find(
      (entry) => planarTargetOverrideTargetId(entry) === targetId,
    );
    return expectedEntry
      ? currentEntry !== undefined &&
          valueSatisfiesPatch(currentEntry, expectedEntry)
      : currentEntry === undefined;
  });
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
      return [visualizationOverrideTargetId(entry)];
    }),
  );
}

function normalizeTargetIds(targetIds: readonly string[]): readonly string[] {
  return mergeTargetIds(
    [],
    targetIds.filter((targetId) => targetId.length > 0),
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
