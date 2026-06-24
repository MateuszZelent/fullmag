"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";
import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticViewport3DRecord,
  redactDiagnosticDetail,
} from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";
import type { ResourceCacheStats } from "@/kernel/resources/ResourceCache";

import {
  createDiagnosticRecordFromViewport3DBuildDiagnostic,
  subscribeViewport3DBuildDiagnostics,
} from "./build-engine/viewport3dBuildDiagnostics";
import {
  createDiagnosticRecordFromViewport3DWorkerPoolDiagnostic,
  subscribeViewport3DWorkerPoolDiagnostics,
} from "./build-engine/workerPool/viewport3dWorkerPoolDiagnostics";
import {
  createDiagnosticRecordFromViewport3DGpuUploadDiagnostic,
  subscribeViewport3DGpuUploadDiagnostics,
} from "./build-engine/gpu/viewport3dGpuUploadDiagnostics";

export type Viewport3DResourceKind =
  | "geometry"
  | "material"
  | "render-target"
  | "texture"
  | "worker";

export interface Viewport3DResourceCounts {
  dirtyReason: string | null;
  frames: number;
  geometries: number;
  materials: number;
  renderTargets: number;
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

export interface Viewport3DResourceLedgerEntry {
  byteLength: number;
  createdAtMs: number;
  id: string;
  kind: Viewport3DResourceKind;
  label: string;
  owner: string;
}

interface Viewport3DResourceTrackerOptions {
  record?: (record: DiagnosticViewport3DRecord) => void;
}

export interface Viewport3DTrackResourceOptions {
  byteLength?: number;
  id?: string;
  label?: string;
  owner?: string;
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
  renderTargets: 0,
  textures: 0,
  workers: 0,
};

export class Viewport3DResourceTracker {
  private readonly dirtyReasonCounts = new Map<string, number>();
  private readonly disposables = new Map<object, () => void>();
  private readonly ledgerEntries = new Map<object, Viewport3DResourceLedgerEntry>();
  private readonly listeners = new Set<TrackerListener>();
  private counts: Viewport3DResourceCounts = { ...EMPTY_COUNTS };
  private resourceSequence = 0;

  constructor(private readonly options: Viewport3DResourceTrackerOptions = {}) {}

  getSnapshot(): Viewport3DResourceCounts {
    return this.counts;
  }

  getLedgerSnapshot(): Viewport3DResourceLedgerEntry[] {
    return Array.from(this.ledgerEntries.values()).map((entry) => ({ ...entry }));
  }

  recordCanvasReady(detail: Record<string, unknown> = {}): void {
    this.recordViewportEvent({
      detail,
      dirtyReason: "canvas-ready",
      name: DIAGNOSTIC_EVENT_NAMES.viewport3DCanvasReady,
      severity: "info",
    });
  }

  recordContextLost(): void {
    this.counts = {
      ...this.counts,
      contextLosses: this.counts.contextLosses + 1,
      dirtyReason: "context-lost",
    };
    this.recordViewportEvent({
      contextLost: true,
      dirtyReason: "context-lost",
      name: DIAGNOSTIC_EVENT_NAMES.viewport3DContextLost,
      severity: "critical",
    });
    this.notify();
  }

  recordContextRestored(): void {
    this.counts = {
      ...this.counts,
      contextRestores: this.counts.contextRestores + 1,
      dirtyReason: "context-restored",
    };
    this.recordViewportEvent({
      contextLost: false,
      dirtyReason: "context-restored",
      name: DIAGNOSTIC_EVENT_NAMES.viewport3DContextRestored,
      severity: "info",
    });
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
    options: Viewport3DTrackResourceOptions = {},
  ): TResource {
    if (this.disposables.has(resource)) {
      return resource;
    }

    this.disposables.set(resource, () => resource.dispose());
    const ledgerEntry = this.createLedgerEntry(kind, options);
    this.ledgerEntries.set(resource, ledgerEntry);
    memoryBudgetRegistry.registerLedgerEntry({
      byteLength: ledgerEntry.byteLength,
      category: kind === "worker" ? "worker" : "webgl",
      createdAtMs: ledgerEntry.createdAtMs,
      entryCount: 1,
      id: ledgerEntry.id,
      label: ledgerEntry.label,
      maxBytes: null,
      owner: ledgerEntry.owner,
    });
    this.counts = incrementCount(this.counts, kind, 1);
    this.recordViewportEvent({
      detail: {
        byteLength: ledgerEntry.byteLength,
        kind,
        owner: ledgerEntry.owner,
        resourceId: ledgerEntry.id,
      },
      name: DIAGNOSTIC_EVENT_NAMES.viewport3DResourceTracked,
      severity: "info",
    });
    return resource;
  }

  release(
    kind: Viewport3DResourceKind,
    resource: object | null | undefined,
    releaseReason = "released",
  ): void {
    if (!resource) return;
    const dispose = this.disposables.get(resource);
    if (!dispose) return;

    this.disposables.delete(resource);
    const ledgerEntry = this.ledgerEntries.get(resource);
    this.ledgerEntries.delete(resource);
    if (ledgerEntry) {
      memoryBudgetRegistry.releaseLedgerEntry(ledgerEntry.id, releaseReason);
    }
    dispose();
    this.counts = incrementCount(this.counts, kind, -1);
    this.recordViewportEvent({
      detail: {
        byteLength: ledgerEntry?.byteLength ?? null,
        kind,
        owner: ledgerEntry?.owner ?? null,
        releaseReason,
        resourceId: ledgerEntry?.id ?? null,
      },
      name: DIAGNOSTIC_EVENT_NAMES.viewport3DResourceReleased,
      severity: "info",
    });
  }

  disposeAll(): void {
    const disposables = Array.from(this.disposables.entries());
    this.disposables.clear();
    for (const [resource, dispose] of disposables) {
      const ledgerEntry = this.ledgerEntries.get(resource);
      if (ledgerEntry) {
        memoryBudgetRegistry.releaseLedgerEntry(ledgerEntry.id, "tracker-dispose");
      }
      dispose();
    }
    this.ledgerEntries.clear();
    this.counts = {
      ...this.counts,
      geometries: 0,
      materials: 0,
      renderTargets: 0,
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

  private createLedgerEntry(
    kind: Viewport3DResourceKind,
    options: Viewport3DTrackResourceOptions,
  ): Viewport3DResourceLedgerEntry {
    const id =
      options.id ??
      `viewport3d.${kind}.${Date.now()}.${this.resourceSequence++}`;
    return {
      byteLength: normalizeByteLength(options.byteLength),
      createdAtMs: Date.now(),
      id,
      kind,
      label: options.label ?? `Viewport 3D ${kind}`,
      owner: options.owner ?? "viewport-3d",
    };
  }

  private recordViewportEvent({
    contextLost = null,
    detail = {},
    dirtyReason = null,
    name,
    severity,
  }: {
    contextLost?: boolean | null;
    detail?: Record<string, unknown>;
    dirtyReason?: string | null;
    name: string;
    severity: DiagnosticViewport3DRecord["severity"];
  }): void {
    this.options.record?.({
      byteLength: null,
      contextLost,
      detail: redactDiagnosticDetail(detail),
      dirtyReason,
      droppedCount: 0,
      durationMs: null,
      geometries: this.counts.geometries,
      id: "",
      kind: "viewport-3d",
      lane: "viewport-3d",
      materials: this.counts.materials,
      name,
      renderTargets: this.counts.renderTargets,
      severity,
      startTimeMs: null,
      textures: this.counts.textures,
      timestampMs: Date.now(),
      workers: this.counts.workers,
    });
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
  const { diagnosticRecorder } = useKernel();
  const tracker = useMemo(
    () =>
      new Viewport3DResourceTracker({
        record: (record) => diagnosticRecorder.record(record),
      }),
    [diagnosticRecorder],
  );

  useEffect(() => () => tracker.disposeAll(), [tracker]);
  useEffect(
    () =>
      subscribeViewport3DBuildDiagnostics((record) => {
        diagnosticRecorder.record(
          createDiagnosticRecordFromViewport3DBuildDiagnostic(record),
        );
      }),
    [diagnosticRecorder],
  );
  useEffect(
    () =>
      subscribeViewport3DWorkerPoolDiagnostics((record) => {
        diagnosticRecorder.record(
          createDiagnosticRecordFromViewport3DWorkerPoolDiagnostic(record),
        );
      }),
    [diagnosticRecorder],
  );
  useEffect(
    () =>
      subscribeViewport3DGpuUploadDiagnostics((record) => {
        diagnosticRecorder.record(
          createDiagnosticRecordFromViewport3DGpuUploadDiagnostic(record),
        );
      }),
    [diagnosticRecorder],
  );

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
  if (kind === "render-target") {
    return {
      ...counts,
      renderTargets: Math.max(counts.renderTargets + delta, 0),
    };
  }
  if (kind === "texture") {
    return { ...counts, textures: Math.max(counts.textures + delta, 0) };
  }
  return { ...counts, workers: Math.max(counts.workers + delta, 0) };
}

function normalizeByteLength(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}
