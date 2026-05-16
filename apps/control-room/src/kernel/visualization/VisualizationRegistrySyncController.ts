import type {
  RequestOptions,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import type { ResourceRevision } from "../api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

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
  intervalMs?: number;
  maxLatencyMs?: number;
  now?: () => number;
  quietMs?: number;
  resources?: Pick<ResourceInvalidationController, "invalidate">;
}

const DEFAULT_INTERVAL_MS = 1_000;
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
  private readonly intervalMs: number;
  private readonly listeners = new Set<VisualizationRegistrySyncListener>();
  private readonly maxLatencyMs: number;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly resources: Pick<ResourceInvalidationController, "invalidate"> | null;
  private firstPendingAt: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private inflightCameraInvalidationSuppressed = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly suppressedCameraInvalidationRevisions = new Set<string>();
  private snapshot: VisualizationRegistrySyncSnapshot = INITIAL_SNAPSHOT;

  constructor({
    api,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxLatencyMs = DEFAULT_MAX_LATENCY_MS,
    now = Date.now,
    quietMs = DEFAULT_QUIET_MS,
    resources,
  }: VisualizationRegistrySyncControllerOptions) {
    this.api = api;
    this.intervalMs = intervalMs;
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
    // Camera-only patches do not affect rendering settings.  Return the
    // original reference so downstream React memos stay stable.
    if (isCameraOnlyPatch(activePatch)) return remote;
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
      return Promise.resolve();
    }

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
          pendingFingerprint: fingerprintVisualizationPatch(restoredPatch),
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
      });

    return this.flushPromise;
  }

  getSnapshot(): VisualizationRegistrySyncSnapshot {
    return this.snapshot;
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
    const pendingFingerprint = pendingPatch
      ? fingerprintVisualizationPatch(pendingPatch)
      : null;

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
      pendingFingerprint,
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
    const now = this.now();
    const pendingPatch = mergeVisualizationStatePatch(
      this.snapshot.pendingPatch,
      patch,
    );

    if (
      this.snapshot.pendingPatch &&
      stableJson(this.snapshot.pendingPatch) === stableJson(pendingPatch)
    ) {
      return;
    }

    this.firstPendingAt = this.firstPendingAt ?? now;
    this.snapshot = {
      ...this.snapshot,
      error: null,
      lastLocalChangedAt: now,
      pendingFingerprint: fingerprintVisualizationPatch(pendingPatch),
      pendingPatch,
      version: this.snapshot.version + 1,
    };
    if (!isCameraOnlyPatch(pendingPatch)) {
      this.notify();
    }
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      void this.flushDue();
    }, this.intervalMs);
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
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
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

export function applyVisualizationStatePatch<TState>(
  state: TState,
  patch: VisualizationStatePatch | null | undefined,
): TState {
  if (!patch || !hasPatchKeys(patch)) return state;
  return deepMerge(state, patch) as TState;
}

export function mergeVisualizationStatePatch(
  current: VisualizationStatePatch | null | undefined,
  next: VisualizationStatePatch | null | undefined,
): VisualizationStatePatch | null {
  if (!current && !next) return null;
  if (!current) return next ? ({ ...next } as VisualizationStatePatch) : null;
  if (!next) return { ...current };
  return deepMerge(current, next) as VisualizationStatePatch;
}

function fingerprintVisualizationPatch(
  patch: VisualizationStatePatch | null,
): string | null {
  return patch ? stableJson(patch) : null;
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

function valueSatisfiesPatch(value: unknown, patch: unknown): boolean {
  if (Array.isArray(patch)) {
    return stableJson(value) === stableJson(patch);
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

function deepMerge(left: unknown, right: unknown): unknown {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return cloneJson(right);
  }

  const output: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    output[key] =
      isPlainObject(value) && isPlainObject(output[key])
        ? deepMerge(output[key], value)
        : cloneJson(value);
  }
  return output;
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
    ) as T;
  }
  return value;
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

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function isCameraOnlyPatch(
  patch: VisualizationStatePatch | null | undefined,
): boolean {
  if (!patch) return true;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => key === "camera");
}
