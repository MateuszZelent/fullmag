import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ResourceRevision } from "../api/apiTypes";

import type { ResourceKey } from "./resourceTypes";

type ResourceListener = (revision: ResourceRevision) => void;

export class ResourceInvalidationController {
  private readonly revisions = new Map<ResourceKey, ResourceRevision>();
  private readonly listeners = new Map<ResourceKey, Set<ResourceListener>>();

  constructor(private readonly bus: EventBus<KernelEventMap>) {}

  getRevision(resourceKey: ResourceKey): ResourceRevision | null {
    return this.revisions.get(resourceKey) ?? null;
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
