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
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  resourceBuckets.set(args.id, {
    id: args.id,
    label: args.label,
    entries: Math.max(0, Math.trunc(args.entries)),
    estimatedBytes: Math.max(0, Math.trunc(args.estimatedBytes)),
    capacity: args.capacity ?? null,
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
