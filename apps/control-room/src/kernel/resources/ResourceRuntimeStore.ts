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

export interface ResourceRuntimeLoadRequest<TData> {
  externalRevision: ResourceRevision | null;
  force?: boolean;
  load: (context: LoadContext) => Promise<TData>;
  minRefetchIntervalMs?: number;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

export interface ResourceRuntimeSnapshot<TData> extends ResourceState<TData> {
  settledExternalRevision: ResourceRevision | null;
  settledResourceKey: ResourceKey | null;
}

type ResourceRuntimeListener = () => void;

interface ResourceRuntimeEntry<TData> {
  controller: AbortController | null;
  inflight: Promise<ResourceRuntimeSnapshot<TData>> | null;
  inflightExternalRevision: ResourceRevision | null;
  lastSettledAtMs: number;
  listeners: Set<ResourceRuntimeListener>;
  pendingRequest: ResourceRuntimeLoadRequest<TData> | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  sequence: number;
  snapshot: ResourceRuntimeSnapshot<TData>;
}

type StoredResourceRuntimeEntry = ResourceRuntimeEntry<never>;

export interface ResourceRuntimeStoreStats {
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
    sequence: 0,
    snapshot: createInitialSnapshot<TData>(),
  };
}

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
      if (entry.pendingRequest) {
        pendingRequestCount += 1;
      }
      if (entry.snapshot.status === "ready") {
        readyCount += 1;
      }
    }
    return {
      entryCount: this.entries.size,
      inflightCount,
      listenerCount,
      pendingRequestCount,
      readyCount,
    };
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
    entry.snapshot = {
      ...markResourceReady(entry.snapshot, data, revision),
      settledExternalRevision: revision,
      settledResourceKey: resourceKey,
    };
    this.notify(entry);
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
    externalRevision,
    force = false,
    load,
    minRefetchIntervalMs = 0,
    resolveRevision,
    resourceKey,
  }: ResourceRuntimeLoadRequest<TLoadData>): Promise<
    ResourceRuntimeSnapshot<TLoadData>
  > {
    const entry = this.getOrCreateEntry<TLoadData>(resourceKey);

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

    const delayMs = refetchDelayMs(entry, minRefetchIntervalMs);
    if (!force && delayMs > 0) {
      entry.pendingRequest = {
        externalRevision,
        force: false,
        load,
        minRefetchIntervalMs,
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

    if (!force && entry.inflight) {
      entry.pendingRequest = {
        externalRevision,
        force: false,
        load,
        minRefetchIntervalMs,
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
    entry.snapshot = {
      ...markResourceLoading(entry.snapshot, externalRevision),
      settledExternalRevision: entry.snapshot.settledExternalRevision,
      settledResourceKey: entry.snapshot.settledResourceKey,
    };
    this.notify(entry);

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

        entry.snapshot = {
          ...markResourceError(
            entry.snapshot,
            error instanceof Error ? error : new Error(String(error)),
          ),
          settledExternalRevision: externalRevision,
          settledResourceKey: resourceKey,
        };
        return entry.snapshot;
      })
      .finally(() => {
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
    entry.sequence += 1;
    this.entries.delete(resourceKey);
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

function refetchDelayMs<TData>(
  entry: ResourceRuntimeEntry<TData>,
  minRefetchIntervalMs: number,
): number {
  if (
    minRefetchIntervalMs <= 0 ||
    entry.snapshot.status !== "ready" ||
    entry.lastSettledAtMs <= 0
  ) {
    return 0;
  }
  const elapsedMs = Date.now() - entry.lastSettledAtMs;
  return Math.max(0, minRefetchIntervalMs - elapsedMs);
}
