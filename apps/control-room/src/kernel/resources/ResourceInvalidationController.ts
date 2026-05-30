import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ResourceRevision } from "../api/apiTypes";

import type { ResourceKey } from "./resourceTypes";

type ResourceListener = (revision: ResourceRevision) => void;

export class ResourceInvalidationController {
  private readonly revisions = new Map<ResourceKey, ResourceRevision>();
  private readonly prefixRevisions = new Map<ResourceKey, ResourceRevision>();
  private readonly listeners = new Map<ResourceKey, Set<ResourceListener>>();

  constructor(private readonly bus: EventBus<KernelEventMap>) {}

  getRevision(resourceKey: ResourceKey): ResourceRevision | null {
    let revision = this.revisions.get(resourceKey) ?? null;
    for (const [prefix, prefixRevision] of this.prefixRevisions) {
      if (resourceKey !== prefix && resourceKey.startsWith(prefix)) {
        revision =
          revision === null
            ? prefixRevision
            : latestRevision(revision, prefixRevision);
      }
    }
    return revision;
  }

  invalidate(resourceKey: ResourceKey, revision: ResourceRevision): void {
    const current = this.revisions.get(resourceKey);
    if (current === revision || isOlderNumericRevision(revision, current)) {
      return;
    }

    this.revisions.set(resourceKey, revision);
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
      this.prefixRevisions.set(resourcePrefix, revision);
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

function latestRevision(
  current: ResourceRevision,
  next: ResourceRevision,
): ResourceRevision {
  if (typeof current === "number" && typeof next === "number") {
    return Math.max(current, next);
  }
  return next;
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
