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

import type { Viewport3DDerivedBufferCacheSnapshot } from "./build-engine/cache/viewport3dDerivedBufferCache";

import type { Viewport3DFieldDemandDiagnosticSummary } from "./model/viewport3DFieldDataPlan";
import type { Viewport3DTargetDiagnosticSummary } from "./model/viewport3DTargetDiagnostics";
import {
  createDiagnosticRecordFromViewport3DBuildDiagnostic,
  subscribeViewport3DBuildDiagnostics,
} from "./build-engine/viewport3dBuildDiagnostics";
import type { Viewport3DBuildFallbackSnapshot } from "./build-engine/viewport3dBuildEngineTypes";
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
  glyphCacheBytes?: number;
  glyphCacheEntries?: number;
  glyphCacheRetainedBytes?: number;
  materials: number;
  renderTargets: number;
  textures: number;
  workers: number;
  workerRuntimeJobs?: number;
  workerRuntimeTimers?: number;
  workerRuntimeWorkers?: number;
  contextLosses: number;
  contextRestores: number;
}

export interface Viewport3DDiagnosticsInput {
  airboxPartCount: number;
  buildFallbacks?: readonly Viewport3DBuildFallbackSnapshot[];
  cache: ResourceCacheStats;
  dataPlaneIssues?: readonly string[];
  fieldDemandDiagnostics?: readonly Viewport3DFieldDemandDiagnosticSummary[];
  fieldRevision: string | number | null;
  objectCount: number;
  manifestCarrierDegradedCount?: number;
  manifestCarrierKind?: string | null;
  pipelineDiagnostics?: readonly Viewport3DPipelineDiagnosticSummary[];
  quantityId: string;
  surfaceColorStatus?: string | null;
  targetDiagnostics?: readonly Viewport3DTargetDiagnosticSummary[];
  topologyRevision: string | number | null;
  tracker: Viewport3DResourceCounts;
}

export interface Viewport3DPipelineDiagnosticSummary {
  lane: string;
  mainAdoptMs: number;
  mainUploadMs: number;
  queueWaitMs: number;
  transferMs: number;
  workerComputeMs: number;
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
  glyphCacheBytes: 0,
  glyphCacheEntries: 0,
  glyphCacheRetainedBytes: 0,
  materials: 0,
  renderTargets: 0,
  textures: 0,
  workers: 0,
  workerRuntimeJobs: 0,
  workerRuntimeTimers: 0,
  workerRuntimeWorkers: 0,
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

  setWorkerRuntimeCounts(counts: {
    jobs: number;
    timers: number;
    workers: number;
  }): void {
    this.counts = {
      ...this.counts,
      workerRuntimeJobs: counts.jobs,
      workerRuntimeTimers: counts.timers,
      workerRuntimeWorkers: counts.workers,
    };
    this.notify();
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

  recordGlyphDerivedBufferCache(
    snapshot: Viewport3DDerivedBufferCacheSnapshot<unknown>,
  ): void {
    const next = {
      glyphCacheBytes: snapshot.estimatedBytes,
      glyphCacheEntries: snapshot.entryCount,
      glyphCacheRetainedBytes: snapshot.retainedBytes,
    };
    if (
      this.counts.glyphCacheBytes === next.glyphCacheBytes &&
      this.counts.glyphCacheEntries === next.glyphCacheEntries &&
      this.counts.glyphCacheRetainedBytes === next.glyphCacheRetainedBytes
    ) {
      return;
    }
    this.counts = { ...this.counts, ...next };
    this.notify();
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
    ...formatFieldDemandDiagnostics(input.fieldDemandDiagnostics),
    ...formatTargetDiagnostics(input.targetDiagnostics),
    ...formatDataPlaneIssues(input.dataPlaneIssues),
    ...formatPipelineDiagnostics(input.pipelineDiagnostics),
    ...formatBuildFallbackDiagnostics(input.buildFallbacks),
    ...(input.manifestCarrierKind
      ? [
          `carrier:${input.manifestCarrierKind}/${input.manifestCarrierDegradedCount ?? 0}`,
        ]
      : []),
    `obj:${input.objectCount}`,
    `air:${input.airboxPartCount}`,
    `geo:${input.tracker.geometries}`,
    `cache:${formatBytes(input.cache.byteLength)}`,
    `glyph-cache:${input.tracker.glyphCacheEntries ?? 0}/${formatBytes(input.tracker.glyphCacheBytes ?? 0)}/${formatBytes(input.tracker.glyphCacheRetainedBytes ?? 0)}`,
    `worker-runtime:${input.tracker.workerRuntimeWorkers ?? 0}/${input.tracker.workerRuntimeTimers ?? 0}/${input.tracker.workerRuntimeJobs ?? 0}`,
    `frames:${input.tracker.frames}`,
  ].join(" ");
}

function formatBuildFallbackDiagnostics(
  fallbacks: readonly Viewport3DBuildFallbackSnapshot[] | undefined,
): string[] {
  if (!fallbacks?.length) return [];
  const entries = fallbacks
    .slice()
    .sort((left, right) => left.lane.localeCompare(right.lane))
    .slice(0, 3)
    .map((fallback) => {
      return [
        `${fallback.lane}{count=${fallback.count}`,
        `reason=${fallback.reason}`,
        `key=${fallback.key}}`,
      ].join(" ");
    });
  const suffix = fallbacks.length > entries.length ? ";..." : "";
  return [`fallbacks:${fallbacks.length}[${entries.join(";")}${suffix}]`];
}

function formatDataPlaneIssues(
  issues: readonly string[] | undefined,
): string[] {
  if (!issues?.length) return [];
  const entries = issues.slice(0, 3);
  const suffix = issues.length > entries.length ? ";..." : "";
  return [`data-plane:${issues.length}[${entries.join(";")}${suffix}]`];
}

function formatPipelineDiagnostics(
  summaries: readonly Viewport3DPipelineDiagnosticSummary[] | undefined,
): string[] {
  if (!summaries?.length) return [];
  const entries = summaries.slice(0, 3).map((summary) => {
    return [
      `${summary.lane}{queue=${formatDurationMs(summary.queueWaitMs)}`,
      `worker=${formatDurationMs(summary.workerComputeMs)}`,
      `transfer=${formatDurationMs(summary.transferMs)}`,
      `adopt=${formatDurationMs(summary.mainAdoptMs)}`,
      `upload=${formatDurationMs(summary.mainUploadMs)}}`,
    ].join(" ");
  });
  const suffix = summaries.length > entries.length ? ";..." : "";
  return [`pipeline:${summaries.length}[${entries.join(";")}${suffix}]`];
}

function formatDurationMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

function formatFieldDemandDiagnostics(
  summaries: readonly Viewport3DFieldDemandDiagnosticSummary[] | undefined,
): string[] {
  if (!summaries?.length) return [];
  const entries = summaries.slice(0, 2).map((summary) => {
    const demands = summary.demands.join("|") || "none";
    const requests = summary.requests.join("|") || "none";
    return `${summary.targetId}{${demands}=>${requests}}`;
  });
  const suffix = summaries.length > entries.length ? ";..." : "";
  return [`field-demands:${summaries.length}[${entries.join(";")}${suffix}]`];
}

function formatTargetDiagnostics(
  summaries: readonly Viewport3DTargetDiagnosticSummary[] | undefined,
): string[] {
  if (!summaries?.length) return [];
  const entries = summaries.slice(0, 2).map((summary) => {
    const passes = summary.passes.join("|") || "none";
    const demand = summary.demand ?? "none";
    const buffers = summary.buffers.join("|") || "none";
    const derivedWork = summary.derivedWork.join("|") || "none";
    const degradation = summary.degradation.join("|") || "none";
    const retained = summary.retained.join("|") || "none";
    return `${summary.targetId}{passes=${passes} demand=${demand} buffers=${buffers} work=${derivedWork} degradation=${degradation} retained=${retained}}`;
  });
  const suffix = summaries.length > entries.length ? ";..." : "";
  return [`target-passes:${summaries.length}[${entries.join(";")}${suffix}]`];
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
