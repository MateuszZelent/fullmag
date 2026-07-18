"use client";

import type { DecodedTopology } from "@/kernel/api/codecs";

import type { Viewport3DBuildDiagnosticRecord } from "../build-engine/viewport3dBuildEngineTypes";
import { recordViewport3DBuildDiagnostic } from "../build-engine/viewport3dBuildDiagnostics";
import { createViewport3DBuildScheduler } from "../build-engine/viewport3dBuildScheduler";
import {
  buildViewport3DRegionOverlayModels,
  estimateViewport3DRegionOverlayBuildInputBytes,
  type Viewport3DRegionOverlayBuildRequest,
  type Viewport3DRegionOverlayBuildResult,
} from "./viewport3dRegionOverlayBuildModel";
import type {
  Viewport3DRegionOverlayBuildWorkerRequest,
  Viewport3DRegionOverlayBuildWorkerResponse,
} from "./viewport3dRegionOverlayBuildWorker";

export interface Viewport3DRegionOverlayBuildOptions {
  buildKey?: string;
  groupKey?: string;
  latestWins?: boolean;
  onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  revisionSummary?: string;
  signal?: AbortSignal;
}

interface Viewport3DRegionOverlayBuildExecutionOptions
  extends Viewport3DRegionOverlayBuildOptions {
  recordFallback?: (reason: string) => void;
}

interface PendingRegionOverlayBuild {
  abortListener: (() => void) | null;
  reject: (reason: unknown) => void;
  resolve: (value: Viewport3DRegionOverlayBuildResult) => void;
  signal: AbortSignal | null;
}

const REGION_OVERLAY_WORKER_IDLE_TIMEOUT_MS = 30_000;

let fallbackRegionOverlayBuildId = 1;
let regionOverlayBuildJobScheduler:
  | ReturnType<typeof createViewport3DBuildScheduler>
  | undefined;
let regionOverlayWorkerClient:
  | RegionOverlayWorkerClient
  | null
  | undefined;
let regionOverlayWorkerFallbackReason: string | null | undefined;

export async function buildViewport3DRegionOverlaysOffMainThread(
  request: Viewport3DRegionOverlayBuildRequest,
  options: Viewport3DRegionOverlayBuildOptions = {},
): Promise<Viewport3DRegionOverlayBuildResult> {
  throwIfAborted(options.signal);
  const buildKey =
    options.buildKey ??
    `region-overlay:adhoc:${fallbackRegionOverlayBuildId++}`;
  const scheduler = getRegionOverlayBuildJobScheduler();
  return scheduler.schedule(
    {
      groupKey: options.groupKey,
      inputBytes: estimateViewport3DRegionOverlayBuildInputBytes(request),
      itemCount: request.regions.length,
      key: buildKey,
      lane: "region-overlay",
      outputBytesEstimate: estimateViewport3DRegionOverlayBuildInputBytes(request),
      revisionSummary: options.revisionSummary ?? buildKey,
    },
    async (_buildRequest, context) => {
      const result = await executeViewport3DRegionOverlayBuild(request, {
        recordFallback: context.recordFallback,
        signal: context.signal,
      });
      return result;
    },
    {
      latestWins: options.latestWins,
      onDiagnosticRecord: options.onDiagnosticRecord,
      signal: options.signal,
    },
  );
}

async function executeViewport3DRegionOverlayBuild(
  request: Viewport3DRegionOverlayBuildRequest,
  options: Viewport3DRegionOverlayBuildExecutionOptions,
): Promise<Viewport3DRegionOverlayBuildResult> {
  throwIfAborted(options.signal);
  const client = getRegionOverlayWorkerClient();
  if (client) {
    try {
      return await client.build(request, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      regionOverlayWorkerFallbackReason = "worker-error";
      options.recordFallback?.(regionOverlayWorkerFallbackReason);
      regionOverlayWorkerClient = null;
    }
  } else {
    options.recordFallback?.(
      regionOverlayWorkerFallbackReason ?? "worker-unavailable",
    );
  }

  return buildViewport3DRegionOverlayModels(request);
}

export function disposeViewport3DRegionOverlayBuildWorker(): void {
  regionOverlayBuildJobScheduler?.dispose();
  regionOverlayBuildJobScheduler = undefined;
  regionOverlayWorkerClient?.dispose();
  regionOverlayWorkerClient = undefined;
  regionOverlayWorkerFallbackReason = undefined;
}

/** @deprecated Use disposeViewport3DRegionOverlayBuildWorker. */
export const disposeViewport3DRegionOverlayBuildWorkerForTests =
  disposeViewport3DRegionOverlayBuildWorker;

export function getViewport3DRegionOverlayWorkerRuntimeCounts(): { timers: number; workers: number } {
  return regionOverlayWorkerClient?.getRuntimeCounts() ?? { timers: 0, workers: 0 };
}
export function getViewport3DRegionOverlayPendingJobCount(): number { return regionOverlayBuildJobScheduler?.getPendingJobCount() ?? 0; }

function getRegionOverlayBuildJobScheduler(): ReturnType<
  typeof createViewport3DBuildScheduler
> {
  if (!regionOverlayBuildJobScheduler) {
    regionOverlayBuildJobScheduler = createViewport3DBuildScheduler({
      laneConcurrency: {
        "region-overlay": 1,
      },
      onDiagnosticRecord: recordViewport3DBuildDiagnostic,
    });
  }
  return regionOverlayBuildJobScheduler;
}

function getRegionOverlayWorkerClient(): RegionOverlayWorkerClient | null {
  if (regionOverlayWorkerClient !== undefined) {
    return regionOverlayWorkerClient;
  }

  if (typeof Worker === "undefined") {
    regionOverlayWorkerFallbackReason = "worker-unavailable";
    regionOverlayWorkerClient = null;
    return regionOverlayWorkerClient;
  }

  try {
    regionOverlayWorkerClient = new RegionOverlayWorkerClient();
    regionOverlayWorkerFallbackReason = null;
  } catch {
    regionOverlayWorkerFallbackReason = "worker-construction-failed";
    regionOverlayWorkerClient = null;
  }
  return regionOverlayWorkerClient;
}

class RegionOverlayWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRegionOverlayBuild>();
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(
      new URL("./viewport3dRegionOverlayBuildWorker.ts", import.meta.url),
      {
        name: "fullmag-viewport3d-region-overlay-build",
        type: "module",
      },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  build(
    input: Viewport3DRegionOverlayBuildRequest,
    options: Viewport3DRegionOverlayBuildOptions,
  ): Promise<Viewport3DRegionOverlayBuildResult> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Viewport 3D region overlay worker has been disposed."),
      );
    }
    throwIfAborted(options.signal);
    this.clearIdleDisposeTimer();
    const id = this.nextId++;
    const request = cloneRegionOverlayWorkerRequest(input, id);
    const transferables: Transferable[] = [];
    addArrayBufferTransferable(transferables, request.topology.boundaryFaces.buffer);
    addArrayBufferTransferable(transferables, request.topology.boundaryMarkers.buffer);
    addArrayBufferTransferable(transferables, request.topology.elementMarkers.buffer);
    addArrayBufferTransferable(transferables, request.topology.indices.buffer);
    addArrayBufferTransferable(transferables, request.topology.positions.buffer);

    return new Promise((resolve, reject) => {
      const signal = options.signal ?? null;
      const abortListener = signal ? () => this.abortPending(id) : null;
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(id, {
        abortListener,
        reject,
        resolve,
        signal,
      });
      try {
        this.worker.postMessage(request, transferables);
      } catch (error) {
        this.clearPending(id);
        this.dispose(error);
        reject(error);
      }
    });
  }

  dispose(reason?: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleDisposeTimer();
    const error =
      reason instanceof Error
        ? reason
        : new Error("Viewport 3D region overlay worker has been disposed.");
    for (const id of this.pending.keys()) {
      const pending = this.clearPending(id);
      pending?.reject(error);
    }
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleError);
    this.worker.terminate();
    if (regionOverlayWorkerClient === this) {
      regionOverlayWorkerClient = undefined;
    }
  }

  getRuntimeCounts(): { timers: number; workers: number } {
    return { timers: this.idleTimeoutId === null ? 0 : 1, workers: this.disposed ? 0 : 1 };
  }

  private readonly handleMessage = (
    event: MessageEvent<Viewport3DRegionOverlayBuildWorkerResponse>,
  ): void => {
    if (this.disposed) return;
    const response = event.data;
    const pending = this.clearPending(response.id);
    if (!pending) return;

    if (response.ok) {
      pending.resolve(response.data);
      this.scheduleIdleDispose();
      return;
    }

    const error = new Error(response.error.message);
    error.name = response.error.name;
    pending.reject(error);
    this.scheduleIdleDispose();
  };

  private readonly handleError = (event: Event): void => {
    const message =
      typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent
        ? event.message
        : "Viewport 3D region overlay worker failed.";
    const error = new Error(message);
    error.name = "Viewport3DRegionOverlayWorkerError";
    this.dispose(error);
  };

  private abortPending(id: number): void {
    const pending = this.clearPending(id);
    if (!pending) return;
    pending.reject(createAbortError());
    this.scheduleIdleDispose();
  }

  private clearPending(id: number): PendingRegionOverlayBuild | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private scheduleIdleDispose(): void {
    if (this.pending.size > 0 || this.idleTimeoutId !== null) return;
    this.idleTimeoutId = setTimeout(() => {
      this.idleTimeoutId = null;
      this.dispose();
    }, REGION_OVERLAY_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleDisposeTimer(): void {
    if (this.idleTimeoutId === null) return;
    clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = null;
  }
}

function cloneRegionOverlayWorkerRequest(
  input: Viewport3DRegionOverlayBuildRequest,
  id: number,
): Viewport3DRegionOverlayBuildWorkerRequest {
  return {
    ...input,
    id,
    magneticParts: input.magneticParts.map((part) => ({ ...part })),
    regions: input.regions.map((region) => ({ ...region })),
    topology: cloneRegionOverlayTopology(input.topology),
  };
}

function cloneRegionOverlayTopology(topology: DecodedTopology): DecodedTopology {
  return {
    ...topology,
    boundaryFaces: new Uint32Array(topology.boundaryFaces),
    boundaryMarkers: new Uint32Array(topology.boundaryMarkers),
    elementMarkers: new Uint32Array(topology.elementMarkers),
    indices: new Uint32Array(topology.indices),
    positions: new Float64Array(topology.positions),
  };
}

function addArrayBufferTransferable(
  transferables: Transferable[],
  buffer: ArrayBufferLike | undefined,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Region overlay build aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
