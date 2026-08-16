"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { recordViewport3DBuildDiagnostic } from "../build-engine/viewport3dBuildDiagnostics";
import type { Viewport3DBuildDiagnosticRecord } from "../build-engine/viewport3dBuildEngineTypes";
import { createViewport3DBuildScheduler } from "../build-engine/viewport3dBuildScheduler";
import {
  buildViewport3DFdmCuboid,
  estimateFdmCuboidBuildInputBytes,
  estimateFdmCuboidBuildOutputBytes,
  type FdmCuboidBuildRequest,
  type FdmCuboidBuildResult,
  type FdmVectorOnlyBuildRequest,
} from "./fdmCuboidBuildModel";
import type {
  FdmCuboidBuildWorkerRequest,
  FdmCuboidBuildWorkerResponse,
} from "./fdmCuboidBuildWorker";

export interface FdmCuboidBuildOptions {
  buildKey?: string;
  groupKey?: string;
  latestWins?: boolean;
  onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  revisionSummary?: string;
  signal?: AbortSignal;
}

interface FdmCuboidBuildExecutionOptions extends FdmCuboidBuildOptions {
  recordFallback?: (reason: string) => void;
}

interface PendingFdmCuboidBuild {
  abortListener: (() => void) | null;
  reject: (reason: unknown) => void;
  resolve: (value: FdmCuboidBuildResult) => void;
  signal: AbortSignal | null;
}

const FDM_CUBOID_WORKER_IDLE_TIMEOUT_MS = 30_000;

let fallbackFdmCuboidBuildId = 1;
let fdmCuboidBuildJobScheduler:
  | ReturnType<typeof createViewport3DBuildScheduler>
  | undefined;
let fdmCuboidWorkerClient: FdmCuboidWorkerClient | null | undefined;
let fdmCuboidWorkerFallbackReason: string | null | undefined;

export function disposeViewport3DFdmCuboidBuildWorker(): void {
  fdmCuboidBuildJobScheduler?.dispose();
  fdmCuboidBuildJobScheduler = undefined;
  fdmCuboidWorkerClient?.dispose();
  fdmCuboidWorkerClient = undefined;
  fdmCuboidWorkerFallbackReason = undefined;
}

export function getViewport3DFdmCuboidWorkerRuntimeCounts(): { timers: number; workers: number } {
  return fdmCuboidWorkerClient?.getRuntimeCounts() ?? { timers: 0, workers: 0 };
}
export function getViewport3DFdmCuboidPendingJobCount(): number { return fdmCuboidBuildJobScheduler?.getPendingJobCount() ?? 0; }

export async function buildViewport3DFdmCuboidOffMainThread(
  request: FdmCuboidBuildRequest,
  options: FdmCuboidBuildOptions = {},
): Promise<FdmCuboidBuildResult> {
  throwIfAborted(options.signal);
  const buildKey =
    options.buildKey ?? `fdm-cuboid:adhoc:${fallbackFdmCuboidBuildId++}`;
  const scheduler = getFdmCuboidBuildJobScheduler();
  return scheduler.schedule(
    {
      groupKey: options.groupKey,
      inputBytes: estimateFdmCuboidBuildInputBytes(request),
      itemCount: request.domain?.displayCellCount ?? 0,
      key: buildKey,
      lane: "fdm-cuboid",
      outputBytesEstimate: estimateFdmCuboidBuildOutputBytes(request),
      revisionSummary: options.revisionSummary ?? buildKey,
    },
    (_buildRequest, context) =>
      executeFdmCuboidBuild(request, {
        recordFallback: context.recordFallback,
        signal: context.signal,
      }),
    {
      latestWins: options.latestWins,
      onDiagnosticRecord: options.onDiagnosticRecord,
      signal: options.signal,
    },
  );
}

/** Schedule a vector-only FDM build without allocating cuboid matrices. */
export async function buildViewport3DFdmVectorsOffMainThread(
  request: FdmVectorOnlyBuildRequest,
  options: FdmCuboidBuildOptions = {},
): Promise<FdmCuboidBuildResult> {
  return buildViewport3DFdmCuboidOffMainThread(
    {
      cellSelection: "all",
      domain: null,
      maxVectorGlyphs: request.maxVectors,
      realizedRegionIds: null,
      vectorAnchorMode: request.anchorMode,
      vectorField: request.fieldVector,
      vectorGeometryScope: request.geometryScope,
      vectorOnly: {
        anchors: request.anchors,
        cellIndices: request.cellIndices,
        gridShape: request.gridShape,
      },
      vectorScale: request.scale,
      voxelFillRatio: 1,
      voxelMagnitudeThreshold: 0,
      voxelTopography: { amplitudeCells: 0, component: "z", enabled: false },
    },
    {
      ...options,
      groupKey: options.groupKey ?? "fdm-vector-only",
    },
  );
}

async function executeFdmCuboidBuild(
  request: FdmCuboidBuildRequest,
  options: FdmCuboidBuildExecutionOptions,
): Promise<FdmCuboidBuildResult> {
  throwIfAborted(options.signal);
  const client = getFdmCuboidWorkerClient();
  if (client) {
    try {
      return await client.build(request, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      fdmCuboidWorkerFallbackReason = "worker-error";
      options.recordFallback?.(fdmCuboidWorkerFallbackReason);
      fdmCuboidWorkerClient = null;
    }
  } else {
    options.recordFallback?.(
      fdmCuboidWorkerFallbackReason ?? "worker-unavailable",
    );
  }

  return buildViewport3DFdmCuboid(request);
}

function getFdmCuboidBuildJobScheduler(): ReturnType<
  typeof createViewport3DBuildScheduler
> {
  if (!fdmCuboidBuildJobScheduler) {
    fdmCuboidBuildJobScheduler = createViewport3DBuildScheduler({
      laneConcurrency: {
        "fdm-cuboid": 1,
      },
      onDiagnosticRecord: recordViewport3DBuildDiagnostic,
    });
  }
  return fdmCuboidBuildJobScheduler;
}

function getFdmCuboidWorkerClient(): FdmCuboidWorkerClient | null {
  if (fdmCuboidWorkerClient !== undefined) {
    return fdmCuboidWorkerClient;
  }

  if (typeof Worker === "undefined") {
    fdmCuboidWorkerFallbackReason = "worker-unavailable";
    fdmCuboidWorkerClient = null;
    return fdmCuboidWorkerClient;
  }

  try {
    fdmCuboidWorkerClient = new FdmCuboidWorkerClient();
    fdmCuboidWorkerFallbackReason = null;
  } catch {
    fdmCuboidWorkerFallbackReason = "worker-construction-failed";
    fdmCuboidWorkerClient = null;
  }
  return fdmCuboidWorkerClient;
}

class FdmCuboidWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingFdmCuboidBuild>();
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(
      new URL("./fdmCuboidBuildWorker.ts", import.meta.url),
      {
        name: "fullmag-viewport3d-fdm-cuboid-build",
        type: "module",
      },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  build(
    input: FdmCuboidBuildRequest,
    options: FdmCuboidBuildOptions,
  ): Promise<FdmCuboidBuildResult> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Viewport 3D FDM cuboid worker has been disposed."),
      );
    }
    throwIfAborted(options.signal);
    this.clearIdleDisposeTimer();
    const id = this.nextId++;
    const request = cloneFdmCuboidBuildRequestForWorker(input, id);
    const transferables = transferablesForFdmCuboidBuildRequest(request);

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
        : new Error("Viewport 3D FDM cuboid worker has been disposed.");
    for (const id of this.pending.keys()) {
      const pending = this.clearPending(id);
      pending?.reject(error);
    }
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleError);
    this.worker.terminate();
    if (fdmCuboidWorkerClient === this) {
      fdmCuboidWorkerClient = undefined;
    }
  }

  getRuntimeCounts(): { timers: number; workers: number } {
    return { timers: this.idleTimeoutId === null ? 0 : 1, workers: this.disposed ? 0 : 1 };
  }

  private readonly handleMessage = (
    event: MessageEvent<FdmCuboidBuildWorkerResponse>,
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
        : "Viewport 3D FDM cuboid worker failed.";
    const error = new Error(message);
    error.name = "Viewport3DFdmCuboidWorkerError";
    this.dispose(error);
  };

  private abortPending(id: number): void {
    const pending = this.clearPending(id);
    if (!pending) return;
    pending.reject(createAbortError());
    this.scheduleIdleDispose();
  }

  private clearPending(id: number): PendingFdmCuboidBuild | null {
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
    }, FDM_CUBOID_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleDisposeTimer(): void {
    if (this.idleTimeoutId === null) return;
    clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = null;
  }
}

function cloneFdmCuboidBuildRequestForWorker(
  input: FdmCuboidBuildRequest,
  id: number,
): FdmCuboidBuildWorkerRequest {
  return {
    ...input,
    id,
    modelFieldVector: cloneFieldVectorForWorker(input.modelFieldVector),
    nativeActiveMask: input.nativeActiveMask
      ? new Uint8Array(input.nativeActiveMask)
      : input.nativeActiveMask,
    realizedRegionIds: input.realizedRegionIds
      ? new Uint32Array(input.realizedRegionIds)
      : input.realizedRegionIds,
    vectorField: cloneFieldVectorForWorker(input.vectorField),
    vectorOnly: input.vectorOnly
      ? {
          anchors: new Float32Array(input.vectorOnly.anchors),
          cellIndices: new Uint32Array(input.vectorOnly.cellIndices),
          gridShape: input.vectorOnly.gridShape,
        }
      : input.vectorOnly,
  };
}

function cloneFieldVectorForWorker(
  fieldVector: DecodedFieldVector | null | undefined,
): DecodedFieldVector | null | undefined {
  if (!fieldVector) return fieldVector;
  return {
    ...fieldVector,
    values: cloneFieldVectorValues(fieldVector.values),
  };
}

function cloneFieldVectorValues(values: DecodedFieldVector["values"]) {
  return new Float64Array(values);
}

function transferablesForFdmCuboidBuildRequest(
  request: FdmCuboidBuildWorkerRequest,
): Transferable[] {
  const transferables: Transferable[] = [];
  addArrayBufferTransferable(transferables, request.modelFieldVector?.values.buffer);
  addArrayBufferTransferable(transferables, request.nativeActiveMask?.buffer);
  if (request.vectorField?.values.buffer !== request.modelFieldVector?.values.buffer) {
    addArrayBufferTransferable(transferables, request.vectorField?.values.buffer);
  }
  addArrayBufferTransferable(transferables, request.realizedRegionIds?.buffer);
  addArrayBufferTransferable(transferables, request.vectorOnly?.anchors.buffer);
  addArrayBufferTransferable(transferables, request.vectorOnly?.cellIndices.buffer);
  return transferables;
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
  const error = new Error("FDM cuboid build aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "FDM cuboid build aborted")
  );
}
