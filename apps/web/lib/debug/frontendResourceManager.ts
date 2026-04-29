import { useSyncExternalStore } from "react";

export interface FrontendResourceBucket {
  id: string;
  label: string;
  entries: number;
  estimatedBytes: number;
  capacity?: number | null;
  updatedAt: number;
}

const resourceListeners = new Set<() => void>();
const resourceBuckets = new Map<string, FrontendResourceBucket>();
let resourceSnapshot: FrontendResourceBucket[] = [];

function emitResourceChange(): void {
  for (const listener of resourceListeners) {
    listener();
  }
}

function refreshResourceSnapshot(): void {
  resourceSnapshot = Array.from(resourceBuckets.values()).sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function getResourceSnapshot(): FrontendResourceBucket[] {
  return resourceSnapshot;
}

function subscribeResource(listener: () => void): () => void {
  resourceListeners.add(listener);
  return () => {
    resourceListeners.delete(listener);
  };
}

export function updateFrontendResourceBucket(args: {
  id: string;
  label: string;
  entries: number;
  estimatedBytes: number;
  capacity?: number | null;
}): void {
  const nextEntries = Math.max(0, Math.trunc(args.entries));
  const nextEstimatedBytes = Math.max(0, Math.trunc(args.estimatedBytes));
  const nextCapacity = args.capacity ?? null;
  const previous = resourceBuckets.get(args.id);
  if (
    previous &&
    previous.label === args.label &&
    previous.entries === nextEntries &&
    previous.estimatedBytes === nextEstimatedBytes &&
    previous.capacity === nextCapacity
  ) {
    return;
  }

  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  resourceBuckets.set(args.id, {
    id: args.id,
    label: args.label,
    entries: nextEntries,
    estimatedBytes: nextEstimatedBytes,
    capacity: nextCapacity,
    updatedAt: now,
  });
  refreshResourceSnapshot();
  emitResourceChange();
}

export function removeFrontendResourceBucket(id: string): void {
  if (!resourceBuckets.delete(id)) {
    return;
  }
  refreshResourceSnapshot();
  emitResourceChange();
}

export function useFrontendResourceBuckets(): FrontendResourceBucket[] {
  return useSyncExternalStore(
    subscribeResource,
    getResourceSnapshot,
    getResourceSnapshot,
  );
}
