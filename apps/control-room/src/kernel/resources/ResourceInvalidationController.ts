import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ResourceRevision } from "../api/apiTypes";

import type { ResourceKey } from "./resourceTypes";

type ResourceListener = (revision: ResourceRevision) => void;

export class ResourceInvalidationController {
  private readonly revisions = new Map<ResourceKey, ResourceRevision>();
  private readonly revisionOrders = new Map<ResourceKey, number>();
  private readonly prefixRevisions = new Map<ResourceKey, ResourceRevision>();
  private readonly prefixRevisionOrders = new Map<ResourceKey, number>();
  private readonly listeners = new Map<ResourceKey, Set<ResourceListener>>();
  private sequence = 0;

  constructor(private readonly bus: EventBus<KernelEventMap>) {}

  getRevision(resourceKey: ResourceKey): ResourceRevision | null {
    let revision = this.revisions.get(resourceKey) ?? null;
    let revisionOrder = this.revisionOrders.get(resourceKey) ?? -1;
    for (const [prefix, prefixRevision] of this.prefixRevisions) {
      if (resourceKey !== prefix && resourceKey.startsWith(prefix)) {
        const prefixRevisionOrder =
          this.prefixRevisionOrders.get(prefix) ?? -1;
        const selected = selectRevision(
          revision,
          revisionOrder,
          prefixRevision,
          prefixRevisionOrder,
        );
        revision = selected.revision;
        revisionOrder = selected.order;
      }
    }
    return revision;
  }

  invalidate(resourceKey: ResourceKey, revision: ResourceRevision): void {
    const current = this.revisions.get(resourceKey);
    if (current === revision || isOlderNumericRevision(revision, current)) {
      return;
    }

    const revisionOrder = ++this.sequence;
    this.revisions.set(resourceKey, revision);
    this.revisionOrders.set(resourceKey, revisionOrder);
    this.bus.emit("resource:invalidated", { resourceKey, revision });

    const listeners = this.listeners.get(resourceKey);
    if (!listeners) return;

    for (const listener of listeners) {
      listener(revision);
    }
  }

  invalidatePrefix(
    resourcePrefix: ResourceKey,
    revision: ResourceRevision,
  ): void {
    const current = this.prefixRevisions.get(resourcePrefix);
    if (current !== revision && !isOlderNumericRevision(revision, current)) {
      const revisionOrder = ++this.sequence;
      this.prefixRevisions.set(resourcePrefix, revision);
      this.prefixRevisionOrders.set(resourcePrefix, revisionOrder);
    }

    for (const resourceKey of this.listeners.keys()) {
      if (
        resourceKey !== resourcePrefix &&
        resourceKey.startsWith(resourcePrefix)
      ) {
        this.invalidate(resourceKey, revision);
      }
    }
  }

  invalidateMatching(
    predicate: (resourceKey: ResourceKey) => boolean,
    revision: ResourceRevision,
  ): void {
    for (const resourceKey of this.listeners.keys()) {
      if (predicate(resourceKey)) {
        this.invalidate(resourceKey, revision);
      }
    }
  }

  subscribe(resourceKey: ResourceKey, listener: ResourceListener): () => void {
    const listeners =
      this.listeners.get(resourceKey) ?? new Set<ResourceListener>();
    listeners.add(listener);
    this.listeners.set(resourceKey, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(resourceKey);
      }
    };
  }
}

function selectRevision(
  current: ResourceRevision | null,
  currentOrder: number,
  next: ResourceRevision,
  nextOrder: number,
): { order: number; revision: ResourceRevision } {
  if (current === null) {
    return { order: nextOrder, revision: next };
  }

  if (typeof current === "number" && typeof next === "number") {
    return next > current
      ? { order: nextOrder, revision: next }
      : { order: currentOrder, revision: current };
  }

  return nextOrder > currentOrder
    ? { order: nextOrder, revision: next }
    : { order: currentOrder, revision: current };
}

function isOlderNumericRevision(
  next: ResourceRevision,
  current: ResourceRevision | undefined,
): boolean {
  return (
    typeof next === "number" &&
    typeof current === "number" &&
    next < current
  );
}
