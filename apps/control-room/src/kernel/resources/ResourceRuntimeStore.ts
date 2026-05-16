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
  listeners: Set<ResourceRuntimeListener>;
  sequence: number;
  snapshot: ResourceRuntimeSnapshot<TData>;
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
    listeners: new Set<ResourceRuntimeListener>(),
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
  private readonly entries = new Map<ResourceKey, ResourceRuntimeEntry<unknown>>();

  getSnapshot<TSnapshotData = TData>(
    resourceKey: ResourceKey,
  ): ResourceRuntimeSnapshot<TSnapshotData> {
    const entry = this.entries.get(resourceKey) as
      | ResourceRuntimeEntry<TSnapshotData>
      | undefined;
    return entry?.snapshot ?? createInitialSnapshot<TSnapshotData>();
  }

  subscribe(
    resourceKey: ResourceKey,
    listener: ResourceRuntimeListener,
  ): () => void {
    const entry = this.getOrCreateEntry(resourceKey);
    entry.listeners.add(listener);

    return () => {
      entry.listeners.delete(listener);
    };
  }

  ensureLoad<TLoadData = TData>({
    externalRevision,
    force = false,
    load,
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

    entry.controller?.abort();
    const controller = new AbortController();
    const sequence = entry.sequence + 1;
    entry.controller = controller;
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
        entry.controller = null;
        entry.inflight = null;
        entry.inflightExternalRevision = null;
        this.notify(entry);
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
    this.entries.set(resourceKey, entry);
    return entry;
  }

  private notify(entry: ResourceRuntimeEntry<unknown>): void {
    for (const listener of entry.listeners) {
      listener();
    }
  }
}

export const sharedResourceRuntimeStore = new ResourceRuntimeStore();
