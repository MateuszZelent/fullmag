import type { ResourceRevision } from "../api/apiTypes";

import {
  markResourceError,
  markResourceLoading,
  markResourceReady,
  type ResourceState,
} from "./resourceState";
import type { ResourceKey } from "./resourceTypes";

interface LoadContext {
  signal: AbortSignal;
}

/**
 * Bounded retry is opt-in at the runtime boundary so existing callers keep
 * their single-attempt behaviour. Resource hooks provide a conservative
 * default for resources that can be materialized asynchronously.
 */
export interface ResourceRetryPolicy {
  deadlineMs?: number;
  maxAttempts?: number;
  retryAfterMs?: number;
  retry_after_ms?: number;
  retryableReasonCodes?: readonly string[];
}

export interface ResourceRetryDecision {
  delayMs: number;
  reasonCode: string | null;
  retry: boolean;
}

export interface ResourceRuntimeLoadRequest<TData> {
  abortStaleInflight?: boolean;
  externalRevision: ResourceRevision | null;
  force?: boolean;
  load: (context: LoadContext) => Promise<TData>;
  minRefetchIntervalMs?: number;
  retryPolicy?: ResourceRetryPolicy;
  retrying?: boolean;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

export interface ResourceRuntimeSnapshot<TData> extends ResourceState<TData> {
  settledExternalRevision: ResourceRevision | null;
  settledResourceKey: ResourceKey | null;
}

type ResourceRuntimeListener = () => void;
type ResourceRuntimePausePredicate = (resourceKey: ResourceKey) => boolean;

interface ResourceRuntimeEntry<TData> {
  controller: AbortController | null;
  inflight: Promise<ResourceRuntimeSnapshot<TData>> | null;
  inflightExternalRevision: ResourceRevision | null;
  lastSettledAtMs: number;
  listeners: Set<ResourceRuntimeListener>;
  pendingRequest: ResourceRuntimeLoadRequest<TData> | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  retryDeadlineAtMs: number;
  retryExternalRevision: ResourceRevision | null;
  retryRequest: ResourceRuntimeLoadRequest<TData> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  sequence: number;
  snapshot: ResourceRuntimeSnapshot<TData>;
}

type StoredResourceRuntimeEntry = ResourceRuntimeEntry<never>;

export interface ResourceRuntimeStoreStats {
  activePauseCount: number;
  entryCount: number;
  inflightCount: number;
  listenerCount: number;
  pendingRequestCount: number;
  readyCount: number;
}

const INITIAL_RUNTIME_SNAPSHOT: ResourceRuntimeSnapshot<unknown> = {
  data: null,
  error: null,
  revision: null,
  settledExternalRevision: null,
  settledResourceKey: null,
  status: "loading",
};

function createInitialSnapshot<TData>(): ResourceRuntimeSnapshot<TData> {
  return INITIAL_RUNTIME_SNAPSHOT as ResourceRuntimeSnapshot<TData>;
}

function createEntry<TData>(): ResourceRuntimeEntry<TData> {
  return {
    controller: null,
    inflight: null,
    inflightExternalRevision: null,
    lastSettledAtMs: 0,
    listeners: new Set<ResourceRuntimeListener>(),
    pendingRequest: null,
    pendingTimer: null,
    retryAttempt: 0,
    retryDeadlineAtMs: 0,
    retryExternalRevision: null,
    retryRequest: null,
    retryTimer: null,
    deadlineTimer: null,
    sequence: 0,
    snapshot: createInitialSnapshot<TData>(),
  };
}

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function errorReasonCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    code?: unknown;
    reasonCode?: unknown;
    reason_code?: unknown;
  };
  for (const value of [record.reason_code, record.reasonCode, record.code]) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function errorRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    retryAfterMs?: unknown;
    retry_after_ms?: unknown;
  };
  for (const value of [record.retry_after_ms, record.retryAfterMs]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

const DEFAULT_RETRYABLE_REASON_CODES = new Set([
  "field_materialization_pending",
  "field_pending",
  "field_unmaterialized",
  "materialization_pending",
  "not_ready",
  "pending",
  "temporary_not_found",
  "transient_not_found",
]);

function retryableReasonCodes(policy: ResourceRetryPolicy): Set<string> {
  return new Set(
    policy.retryableReasonCodes?.map((reasonCode) => reasonCode.trim()) ??
      DEFAULT_RETRYABLE_REASON_CODES,
  );
}

function boundedPositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function resolveResourceRetryDecision(
  error: unknown,
  policy: ResourceRetryPolicy | undefined,
  attempt: number,
  nowMs = Date.now(),
  deadlineAtMs = 0,
): ResourceRetryDecision {
  if (!policy || abortError(error)) {
    return { delayMs: 0, reasonCode: errorReasonCode(error), retry: false };
  }

  const reasonCode = errorReasonCode(error);
  const status = errorStatus(error);
  const allowedReasons = retryableReasonCodes(policy);
  const reasonAllowed = reasonCode === null || allowedReasons.has(reasonCode);
  const retryableStatus =
    status === null ||
    status === 202 ||
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;
  const transientNotFound = status === 404 && reasonCode !== null && reasonAllowed;
  const retryable =
    status !== 409 &&
    reasonAllowed &&
    (transientNotFound || (status !== 404 && retryableStatus));
  if (!retryable) {
    return { delayMs: 0, reasonCode, retry: false };
  }

  const maxAttempts = boundedPositiveNumber(policy.maxAttempts, 3);
  if (attempt >= maxAttempts) {
    return { delayMs: 0, reasonCode, retry: false };
  }

  const configuredDelay = Math.max(
    0,
    policy.retryAfterMs ?? policy.retry_after_ms ?? 0,
  );
  const responseDelay = errorRetryAfterMs(error) ?? 0;
  const delayMs = Math.max(configuredDelay, responseDelay);
  const deadline = deadlineAtMs > 0 ? deadlineAtMs : nowMs + boundedPositiveNumber(policy.deadlineMs, 5_000);
  if (nowMs >= deadline) {
    return { delayMs: 0, reasonCode, retry: false };
  }
  return {
    delayMs: Math.min(delayMs, Math.max(0, deadline - nowMs)),
    reasonCode,
    retry: true,
  };
}

export function shouldRetryResourceError(
  error: unknown,
  policy: ResourceRetryPolicy | undefined,
): boolean {
  return resolveResourceRetryDecision(error, policy, 1).retry;
}

function settledForExternalRevision<TData>(
  snapshot: ResourceRuntimeSnapshot<TData>,
  resourceKey: ResourceKey,
  externalRevision: ResourceRevision | null,
): boolean {
  return (
    snapshot.status === "ready" &&
    snapshot.settledResourceKey === resourceKey &&
    (snapshot.settledExternalRevision === externalRevision ||
      snapshot.revision === externalRevision)
  );
}

export class ResourceRuntimeStore<TData = unknown> {
  private readonly entries = new Map<ResourceKey, StoredResourceRuntimeEntry>();
  private readonly pausePredicates = new Map<number, ResourceRuntimePausePredicate>();
  private pauseRegistrationId = 0;

  stats(): ResourceRuntimeStoreStats {
    let inflightCount = 0;
    let listenerCount = 0;
    let pendingRequestCount = 0;
    let readyCount = 0;
    for (const stored of this.entries.values()) {
      const entry = stored as unknown as ResourceRuntimeEntry<unknown>;
      if (entry.inflight) {
        inflightCount += 1;
      }
      listenerCount += entry.listeners.size;
      if (entry.pendingRequest || entry.retryRequest) {
        pendingRequestCount += 1;
      }
      if (entry.snapshot.status === "ready") {
        readyCount += 1;
      }
    }
    return {
      activePauseCount: this.pausePredicates.size,
      entryCount: this.entries.size,
      inflightCount,
      listenerCount,
      pendingRequestCount,
      readyCount,
    };
  }

  listenerCounts(): Record<ResourceKey, number> {
    const counts: Record<ResourceKey, number> = {};
    for (const [resourceKey, stored] of this.entries) {
      const entry = stored as unknown as ResourceRuntimeEntry<unknown>;
      if (entry.listeners.size > 0) {
        counts[resourceKey] = entry.listeners.size;
      }
    }
    return counts;
  }

  resetForTests(): void {
    for (const stored of this.entries.values()) {
      const entry = stored as unknown as ResourceRuntimeEntry<unknown>;
      entry.controller?.abort();
      if (entry.pendingTimer) {
        clearTimeout(entry.pendingTimer);
      }
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
      }
      if (entry.deadlineTimer) {
        clearTimeout(entry.deadlineTimer);
      }
    }
    this.entries.clear();
    this.pausePredicates.clear();
  }

  getSnapshot<TSnapshotData = TData>(
    resourceKey: ResourceKey,
  ): ResourceRuntimeSnapshot<TSnapshotData> {
    const entry = this.entries.get(resourceKey) as
      | ResourceRuntimeEntry<TSnapshotData>
      | undefined;
    return entry?.snapshot ?? createInitialSnapshot<TSnapshotData>();
  }

  updateData<TUpdateData = TData>(
    resourceKey: ResourceKey,
    data: TUpdateData,
    revision: ResourceRevision,
  ): void {
    const entry = this.getOrCreateEntry<TUpdateData>(resourceKey);
    entry.sequence += 1;
    entry.controller?.abort();
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
    }
    entry.controller = null;
    entry.inflight = null;
    entry.inflightExternalRevision = null;
    entry.lastSettledAtMs = Date.now();
    entry.pendingRequest = null;
    entry.pendingTimer = null;
    this.clearDeadlineTimer(entry);
    this.clearRetryState(entry);
    entry.snapshot = {
      ...markResourceReady(entry.snapshot, data, revision),
      settledExternalRevision: revision,
      settledResourceKey: resourceKey,
    };
    this.notify(entry);
  }

  pauseLoad(resourceKey: ResourceKey): void {
    const entry = this.entries.get(resourceKey) as
      | ResourceRuntimeEntry<TData>
      | undefined;
    if (!entry) return;
    entry.sequence += 1;
    entry.controller?.abort();
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
    }
    this.clearRetryState(entry);
    this.clearDeadlineTimer(entry);
    entry.controller = null;
    entry.inflight = null;
    entry.inflightExternalRevision = null;
    entry.pendingRequest = null;
    entry.pendingTimer = null;
  }

  cancelRetry(resourceKey: ResourceKey): void {
    const entry = this.entries.get(resourceKey) as
      | ResourceRuntimeEntry<TData>
      | undefined;
    if (!entry) return;
    this.clearRetryState(entry);
  }

  pauseMatching(predicate: (resourceKey: ResourceKey) => boolean): void {
    for (const resourceKey of this.entries.keys()) {
      if (predicate(resourceKey)) {
        this.pauseLoad(resourceKey);
      }
    }
  }

  beginPauseMatching(predicate: ResourceRuntimePausePredicate): () => void {
    const registrationId = ++this.pauseRegistrationId;
    this.pausePredicates.set(registrationId, predicate);
    this.pauseMatching(predicate);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pausePredicates.delete(registrationId);
      this.resumePendingLoads();
    };
  }

  subscribe(
    resourceKey: ResourceKey,
    listener: ResourceRuntimeListener,
  ): () => void {
    const entry = this.getOrCreateEntry(resourceKey);
    entry.listeners.add(listener);

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.releaseUnobservedEntry(resourceKey, entry);
      }
    };
  }

  ensureLoad<TLoadData = TData>({
    abortStaleInflight = false,
    externalRevision,
    force = false,
    load,
    minRefetchIntervalMs = 0,
    retryPolicy,
    retrying = false,
    resolveRevision,
    resourceKey,
  }: ResourceRuntimeLoadRequest<TLoadData>): Promise<
    ResourceRuntimeSnapshot<TLoadData>
  > {
    const entry = this.getOrCreateEntry<TLoadData>(resourceKey);
    if (this.loadPaused(resourceKey)) {
      this.pauseLoad(resourceKey);
      entry.pendingRequest = {
        abortStaleInflight,
        externalRevision,
        force,
        load,
        minRefetchIntervalMs,
        retryPolicy,
        resolveRevision,
        resourceKey,
      };
      return Promise.resolve(entry.snapshot);
    }

    if (
      !force &&
      settledForExternalRevision(entry.snapshot, resourceKey, externalRevision)
    ) {
      if (entry.snapshot.settledExternalRevision !== externalRevision) {
        entry.snapshot = {
          ...entry.snapshot,
          settledExternalRevision: externalRevision,
        };
      }
      return Promise.resolve(entry.snapshot);
    }

    if (
      !force &&
      entry.inflight &&
      entry.inflightExternalRevision === externalRevision
    ) {
      return entry.inflight;
    }

    if (
      !force &&
      entry.retryTimer &&
      entry.retryExternalRevision === externalRevision
    ) {
      return Promise.resolve(entry.snapshot);
    }

    if (
      (force && !retrying) ||
      (entry.retryExternalRevision !== null &&
        entry.retryExternalRevision !== externalRevision)
    ) {
      this.clearRetryState(entry);
    }

    const delayMs = refetchDelayMs(entry, minRefetchIntervalMs);
    if (!force && delayMs > 0) {
      entry.pendingRequest = {
        abortStaleInflight,
        externalRevision,
        force: false,
        load,
        minRefetchIntervalMs,
        retryPolicy,
        resolveRevision,
        resourceKey,
      };
      entry.snapshot = {
        ...markResourceLoading(entry.snapshot, externalRevision),
        settledExternalRevision: entry.snapshot.settledExternalRevision,
        settledResourceKey: entry.snapshot.settledResourceKey,
      };
      this.schedulePendingLoad(entry, delayMs);
      this.notify(entry);
      return Promise.resolve(entry.snapshot);
    }

    if (!force && entry.inflight && abortStaleInflight) {
      entry.sequence += 1;
      this.clearDeadlineTimer(entry);
      entry.controller?.abort();
      entry.controller = null;
      entry.inflight = null;
      entry.inflightExternalRevision = null;
      entry.pendingRequest = null;
    } else if (!force && entry.inflight) {
      entry.pendingRequest = {
        abortStaleInflight,
        externalRevision,
        force: false,
        load,
        minRefetchIntervalMs,
        retryPolicy,
        resolveRevision,
        resourceKey,
      };
      entry.snapshot = {
        ...markResourceLoading(entry.snapshot, externalRevision),
        settledExternalRevision: entry.snapshot.settledExternalRevision,
        settledResourceKey: entry.snapshot.settledResourceKey,
      };
      this.notify(entry);
      return entry.inflight;
    }

    this.clearDeadlineTimer(entry);
    entry.controller?.abort();
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = null;
    }
    const controller = new AbortController();
    const sequence = entry.sequence + 1;
    entry.controller = controller;
    entry.pendingRequest = null;
    entry.sequence = sequence;
    entry.inflightExternalRevision = externalRevision;
    if (retryPolicy) {
      if (
        entry.retryDeadlineAtMs <= 0 ||
        entry.retryExternalRevision !== externalRevision
      ) {
        entry.retryAttempt = 0;
        entry.retryDeadlineAtMs =
          Date.now() + boundedPositiveNumber(retryPolicy.deadlineMs, 5_000);
      }
      entry.retryExternalRevision = externalRevision;
    }
    entry.snapshot = {
      ...markResourceLoading(entry.snapshot, externalRevision),
      settledExternalRevision: entry.snapshot.settledExternalRevision,
      settledResourceKey: entry.snapshot.settledResourceKey,
    };
    this.notify(entry);

    const deadlineAtMs = retryPolicy ? entry.retryDeadlineAtMs : 0;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    if (deadlineAtMs > 0) {
      const remainingMs = Math.max(0, deadlineAtMs - Date.now());
      deadlineTimer = setTimeout(() => {
        if (entry.sequence !== sequence || entry.controller !== controller) {
          return;
        }
        entry.deadlineTimer = null;
        const timeoutError = new Error("Resource load deadline exceeded");
        timeoutError.name = "TimeoutError";
        entry.snapshot = {
          ...markResourceError(entry.snapshot, timeoutError),
          settledExternalRevision: externalRevision,
          settledResourceKey: resourceKey,
        };
        this.clearRetryState(entry);
        controller.abort();
        this.notify(entry);
      }, remainingMs);
      entry.deadlineTimer = deadlineTimer;
    }

    const pending = load({ signal: controller.signal })
      .then((data) => {
        if (entry.sequence !== sequence || controller.signal.aborted) {
          return entry.snapshot;
        }

        entry.snapshot = {
          ...markResourceReady(
            entry.snapshot,
            data,
            resolveRevision?.(data) ?? externalRevision,
          ),
          settledExternalRevision: externalRevision,
          settledResourceKey: resourceKey,
        };
        this.clearRetryState(entry);
        entry.lastSettledAtMs = Date.now();
        return entry.snapshot;
      })
      .catch((error: unknown) => {
        if (
          entry.sequence !== sequence ||
          controller.signal.aborted ||
          abortError(error)
        ) {
          return entry.snapshot;
        }

        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        const partialData = partialResourceData(error);
        const stateWithPartialData: ResourceState<TLoadData> =
          partialData === undefined
            ? entry.snapshot
            : { ...entry.snapshot, data: partialData as TLoadData };
        const errorSnapshot = markResourceError(
          stateWithPartialData,
          normalizedError,
        );
        entry.snapshot = {
          ...errorSnapshot,
          settledExternalRevision: externalRevision,
          settledResourceKey: resourceKey,
        };
        entry.retryAttempt += 1;
        this.scheduleRetry(entry, {
          abortStaleInflight,
          externalRevision,
          force: true,
          load,
          minRefetchIntervalMs,
          retryPolicy,
          retrying: true,
          resolveRevision,
          resourceKey,
        }, error);
        return entry.snapshot;
      })
      .finally(() => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          if (entry.deadlineTimer === deadlineTimer) {
            entry.deadlineTimer = null;
          }
        }
        if (entry.sequence !== sequence) return;
        const pendingRequest = entry.pendingRequest;
        entry.pendingRequest = null;
        entry.controller = null;
        entry.inflight = null;
        entry.inflightExternalRevision = null;
        this.notify(entry);
        if (
          pendingRequest &&
          !settledForExternalRevision(
            entry.snapshot,
            pendingRequest.resourceKey,
            pendingRequest.externalRevision,
          )
        ) {
          this.cancelRetry(pendingRequest.resourceKey);
          void this.ensureLoad(pendingRequest);
        }
      });

    entry.inflight = pending;
    return pending;
  }

  private getOrCreateEntry<TEntryData>(
    resourceKey: ResourceKey,
  ): ResourceRuntimeEntry<TEntryData> {
    const existing = this.entries.get(resourceKey) as
      | ResourceRuntimeEntry<TEntryData>
      | undefined;
    if (existing) return existing;

    const entry = createEntry<TEntryData>();
    this.entries.set(resourceKey, entry as unknown as StoredResourceRuntimeEntry);
    return entry;
  }

  private notify<TEntryData>(entry: ResourceRuntimeEntry<TEntryData>): void {
    for (const listener of entry.listeners) {
      listener();
    }
  }

  private loadPaused(resourceKey: ResourceKey): boolean {
    for (const predicate of this.pausePredicates.values()) {
      if (predicate(resourceKey)) {
        return true;
      }
    }
    return false;
  }

  private resumePendingLoads(): void {
    for (const [resourceKey, stored] of this.entries) {
      if (this.loadPaused(resourceKey)) continue;
      const entry = stored as unknown as ResourceRuntimeEntry<unknown>;
      const pendingRequest = entry.pendingRequest;
      if (!pendingRequest) continue;
      entry.pendingRequest = null;
      void this.ensureLoad(pendingRequest);
    }
  }

  private releaseUnobservedEntry<TEntryData>(
    resourceKey: ResourceKey,
    entry: ResourceRuntimeEntry<TEntryData>,
  ): void {
    if (entry.listeners.size > 0) return;
    entry.controller?.abort();
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
    }
    entry.controller = null;
    entry.inflight = null;
    entry.inflightExternalRevision = null;
    entry.pendingRequest = null;
    entry.pendingTimer = null;
    this.clearDeadlineTimer(entry);
    this.clearRetryState(entry);
    entry.sequence += 1;
    this.entries.delete(resourceKey);
  }

  private clearRetryState<TEntryData>(
    entry: ResourceRuntimeEntry<TEntryData>,
  ): void {
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
    }
    entry.retryTimer = null;
    entry.retryRequest = null;
    entry.retryAttempt = 0;
    entry.retryDeadlineAtMs = 0;
    entry.retryExternalRevision = null;
  }

  private clearDeadlineTimer<TEntryData>(
    entry: ResourceRuntimeEntry<TEntryData>,
  ): void {
    if (entry.deadlineTimer) {
      clearTimeout(entry.deadlineTimer);
    }
    entry.deadlineTimer = null;
  }

  private scheduleRetry<TEntryData>(
    entry: ResourceRuntimeEntry<TEntryData>,
    request: ResourceRuntimeLoadRequest<TEntryData>,
    error: unknown,
  ): void {
    const decision = resolveResourceRetryDecision(
      error,
      request.retryPolicy,
      entry.retryAttempt,
      Date.now(),
      entry.retryDeadlineAtMs,
    );
    if (!decision.retry || entry.retryTimer) {
      entry.retryRequest = null;
      return;
    }

    entry.retryExternalRevision = request.externalRevision;
    entry.retryRequest = request;
    const timer = setTimeout(() => {
      if (entry.retryTimer !== timer) return;
      entry.retryTimer = null;
      const retryRequest = entry.retryRequest;
      entry.retryRequest = null;
      if (
        entry.retryDeadlineAtMs > 0 &&
        Date.now() >= entry.retryDeadlineAtMs
      ) {
        return;
      }
      if (retryRequest && !this.loadPaused(retryRequest.resourceKey)) {
        void this.ensureLoad(retryRequest);
      }
    }, decision.delayMs);
    entry.retryTimer = timer;
    this.notify(entry);
  }

  private schedulePendingLoad<TEntryData>(
    entry: ResourceRuntimeEntry<TEntryData>,
    delayMs: number,
  ): void {
    if (entry.pendingTimer) return;
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = null;
      const pendingRequest = entry.pendingRequest;
      entry.pendingRequest = null;
      if (pendingRequest) {
        void this.ensureLoad(pendingRequest);
      }
    }, delayMs);
  }
}

export const sharedResourceRuntimeStore = new ResourceRuntimeStore();

export function resetSharedResourceRuntimeStoreForTests(): void {
  sharedResourceRuntimeStore.resetForTests();
}

export interface ResourcePartialLoadError<TData> extends Error {
  partialData: TData;
}

export function createResourcePartialLoadError<TData>(
  message: string,
  partialData: TData,
  cause?: unknown,
): ResourcePartialLoadError<TData> {
  const error = new Error(message) as ResourcePartialLoadError<TData>;
  error.name = "ResourcePartialLoadError";
  error.partialData = partialData;
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
    if (cause && typeof cause === "object") {
      const source = cause as Record<string, unknown>;
      const target = error as unknown as Error & Record<string, unknown>;
      for (const field of [
        "code",
        "reasonCode",
        "reason_code",
        "retryAfterMs",
        "retry_after_ms",
        "status",
      ]) {
        if (field in source) target[field] = source[field];
      }
    }
  }
  return error;
}

function partialResourceData<TData>(error: unknown): TData | undefined {
  if (!error || typeof error !== "object" || !("partialData" in error)) {
    return undefined;
  }
  return (error as { partialData?: unknown }).partialData as TData | undefined;
}

function refetchDelayMs<TData>(
  entry: ResourceRuntimeEntry<TData>,
  minRefetchIntervalMs: number,
): number {
  if (minRefetchIntervalMs <= 0 || entry.lastSettledAtMs <= 0) {
    return 0;
  }
  const elapsedMs = Date.now() - entry.lastSettledAtMs;
  return Math.max(0, minRefetchIntervalMs - elapsedMs);
}
