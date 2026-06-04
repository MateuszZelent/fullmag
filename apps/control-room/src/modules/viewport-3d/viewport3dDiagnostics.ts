"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { ResourceCacheStats } from "@/kernel/resources/ResourceCache";

export type Viewport3DResourceKind = "geometry" | "material" | "texture" | "worker";

export interface Viewport3DResourceCounts {
  dirtyReason: string | null;
  frames: number;
  geometries: number;
  materials: number;
  textures: number;
  workers: number;
  contextLosses: number;
  contextRestores: number;
}

export interface Viewport3DDiagnosticsInput {
  airboxPartCount: number;
  cache: ResourceCacheStats;
  fieldRevision: string | number | null;
  objectCount: number;
  quantityId: string;
  surfaceColorStatus?: string | null;
  topologyRevision: string | number | null;
  tracker: Viewport3DResourceCounts;
}

interface DisposableResource {
  dispose: () => void;
}

type TrackerListener = () => void;
export type Viewport3DDirtyReasonCounts = Record<string, number>;

const EMPTY_COUNTS: Viewport3DResourceCounts = {
  contextLosses: 0,
  contextRestores: 0,
  dirtyReason: null,
  frames: 0,
  geometries: 0,
  materials: 0,
  textures: 0,
  workers: 0,
};

export class Viewport3DResourceTracker {
  private readonly dirtyReasonCounts = new Map<string, number>();
  private readonly disposables = new Map<object, () => void>();
  private readonly listeners = new Set<TrackerListener>();
  private counts: Viewport3DResourceCounts = { ...EMPTY_COUNTS };

  getSnapshot(): Viewport3DResourceCounts {
    return this.counts;
  }

  recordContextLost(): void {
    this.counts = {
      ...this.counts,
      contextLosses: this.counts.contextLosses + 1,
      dirtyReason: "context-lost",
    };
    this.notify();
  }

  recordContextRestored(): void {
    this.counts = {
      ...this.counts,
      contextRestores: this.counts.contextRestores + 1,
      dirtyReason: "context-restored",
    };
    this.notify();
  }

  recordDirtyFrame(reason: string): void {
    this.dirtyReasonCounts.set(
      reason,
      (this.dirtyReasonCounts.get(reason) ?? 0) + 1,
    );
    this.counts = {
      ...this.counts,
      dirtyReason: reason,
      frames: this.counts.frames + 1,
    };
  }

  consumeDirtyReasonCounts(): Viewport3DDirtyReasonCounts {
    const counts = Object.fromEntries(this.dirtyReasonCounts);
    this.dirtyReasonCounts.clear();
    return counts;
  }

  track<TResource extends DisposableResource>(
    kind: Viewport3DResourceKind,
    resource: TResource,
  ): TResource {
    if (this.disposables.has(resource)) {
      return resource;
    }

    this.disposables.set(resource, () => resource.dispose());
    this.counts = incrementCount(this.counts, kind, 1);
    return resource;
  }

  release(kind: Viewport3DResourceKind, resource: object | null | undefined): void {
    if (!resource) return;
    const dispose = this.disposables.get(resource);
    if (!dispose) return;

    this.disposables.delete(resource);
    dispose();
    this.counts = incrementCount(this.counts, kind, -1);
  }

  disposeAll(): void {
    const disposables = Array.from(this.disposables.values());
    this.disposables.clear();
    for (const dispose of disposables) {
      dispose();
    }
    this.counts = {
      ...this.counts,
      geometries: 0,
      materials: 0,
      textures: 0,
      workers: 0,
    };
  }

  subscribe(listener: TrackerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function buildViewport3DDiagnostics(
  input: Viewport3DDiagnosticsInput,
): string {
  return [
    `q:${input.quantityId}`,
    `top:${input.topologyRevision ?? "none"}`,
    `field:${input.fieldRevision ?? "none"}`,
    ...(input.surfaceColorStatus
      ? [`surface:${input.surfaceColorStatus}`]
      : []),
    `obj:${input.objectCount}`,
    `air:${input.airboxPartCount}`,
    `geo:${input.tracker.geometries}`,
    `cache:${formatBytes(input.cache.byteLength)}`,
    `frames:${input.tracker.frames}`,
  ].join(" ");
}

export function useViewport3DResourceCounts(
  tracker: Viewport3DResourceTracker,
): Viewport3DResourceCounts {
  return useSyncExternalStore(
    (onStoreChange) => tracker.subscribe(onStoreChange),
    () => tracker.getSnapshot(),
    () => tracker.getSnapshot(),
  );
}

export function useViewport3DResourceTracker(): Viewport3DResourceTracker {
  const tracker = useMemo(() => new Viewport3DResourceTracker(), []);

  useEffect(() => () => tracker.disposeAll(), [tracker]);

  return tracker;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function incrementCount(
  counts: Viewport3DResourceCounts,
  kind: Viewport3DResourceKind,
  delta: number,
): Viewport3DResourceCounts {
  if (kind === "geometry") {
    return { ...counts, geometries: Math.max(counts.geometries + delta, 0) };
  }
  if (kind === "material") {
    return { ...counts, materials: Math.max(counts.materials + delta, 0) };
  }
  if (kind === "texture") {
    return { ...counts, textures: Math.max(counts.textures + delta, 0) };
  }
  return { ...counts, workers: Math.max(counts.workers + delta, 0) };
}
