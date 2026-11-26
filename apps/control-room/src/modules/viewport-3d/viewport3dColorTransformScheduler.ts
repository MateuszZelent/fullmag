"use client";

import type { Viewport3DBuildDiagnosticRecord } from "./build-engine/viewport3dBuildEngineTypes";
import { recordViewport3DBuildDiagnostic } from "./build-engine/viewport3dBuildDiagnostics";
import { createViewport3DBuildScheduler } from "./build-engine/viewport3dBuildScheduler";
import {
  buildViewport3DFieldColorBuffer,
  estimateViewport3DFieldColorBuildInputBytes,
  estimateViewport3DFieldColorBuildOutputBytes,
  type Viewport3DFieldColorBuildTarget,
} from "./field-colors/viewport3dFieldColorBuildModel";
import type {
  Viewport3DFieldColorBuildWorkerRequest,
  Viewport3DFieldColorBuildWorkerResponse,
} from "./field-colors/viewport3dFieldColorBuildWorker";
import {
  type ChunkedFieldTransformOptions,
  type ScalarColorBuffer,
  type Viewport3DFieldVector,
} from "./viewport3dFieldMapping";

export interface Viewport3DColorTransformBuildOptions
  extends ChunkedFieldTransformOptions {
  buildKey?: string;
  groupKey?: string;
  latestWins?: boolean;
  onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  revisionSummary?: string;
  target?: Viewport3DFieldColorBuildTarget;
  /** Reject instead of doing a potentially expensive synchronous fallback. */
  workerRequired?: boolean;
}

interface PendingColorTransform {
  abortListener: (() => void) | null;
  fieldVector: Viewport3DFieldVector;
  options: Viewport3DColorTransformBuildOptions;
  reject: (reason: unknown) => void;
  resolve: (value: ScalarColorBuffer) => void;
  signal: AbortSignal | null;
}

const COLOR_TRANSFORM_WORKER_IDLE_TIMEOUT_MS = 120_000;

let fallbackColorTransformBuildId = 1;
let colorTransformBuildJobScheduler:
  | ReturnType<typeof createViewport3DBuildScheduler>
  | undefined;
let colorTransformWorkerClient:
  | ColorTransformWorkerClient
  | null
  | undefined;
let colorTransformWorkerFallbackReason: string | null | undefined;

export async function buildVertexScalarColorsOffMainThread(
  fieldVector: Viewport3DFieldVector,
  options: Viewport3DColorTransformBuildOptions = {},
): Promise<ScalarColorBuffer> {
  throwIfAborted(options.signal);
  if (options.buildKey) {
    const buildKey =
      options.buildKey ?? `field-color:adhoc:${fallbackColorTransformBuildId++}`;
    const scheduler = getColorTransformBuildJobScheduler();
    return scheduler.schedule(
      {
        groupKey: options.groupKey,
        inputBytes: estimateFieldColorInputBytes(fieldVector, options.target),
        itemCount: fieldVector.pointCount,
        key: buildKey,
        lane: "field-color",
        outputBytesEstimate: estimateFieldColorOutputBytes(fieldVector, options),
        revisionSummary: options.revisionSummary ?? buildKey,
      },
      (_buildRequest, context) =>
        executeVertexScalarColorBuild(fieldVector, {
          ...options,
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

  return executeVertexScalarColorBuild(fieldVector, options);
}

interface Viewport3DColorTransformBuildExecutionOptions
  extends Viewport3DColorTransformBuildOptions {
  recordFallback?: (reason: string) => void;
}

async function executeVertexScalarColorBuild(
  fieldVector: Viewport3DFieldVector,
  options: Viewport3DColorTransformBuildExecutionOptions = {},
): Promise<ScalarColorBuffer> {
  throwIfAborted(options.signal);
  const client = getColorTransformWorkerClient();
  if (client && isWorkerTransferableFieldVector(fieldVector)) {
    try {
      return await client.transform(fieldVector, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      colorTransformWorkerFallbackReason = "worker-error";
      options.recordFallback?.(colorTransformWorkerFallbackReason);
    }
  } else if (!client) {
    options.recordFallback?.(
      colorTransformWorkerFallbackReason ?? "worker-unavailable",
    );
  }

  if (options.workerRequired) {
    throw new Error(
      `Viewport 3D field-color worker is required (${colorTransformWorkerFallbackReason ?? "unsupported-field-vector"}).`,
    );
  }

  const result = await buildViewport3DFieldColorBuffer({
    ...options,
    fieldVector,
    target: options.target ?? defaultFieldColorTarget(fieldVector),
  });
  if (!result) {
    throw new Error("Viewport 3D field-color build returned no buffer.");
  }
  return result;
}

function getColorTransformBuildJobScheduler(): ReturnType<
  typeof createViewport3DBuildScheduler
> {
  if (!colorTransformBuildJobScheduler) {
    colorTransformBuildJobScheduler = createViewport3DBuildScheduler({
      laneConcurrency: {
        "field-color": 1,
      },
      onDiagnosticRecord: recordViewport3DBuildDiagnostic,
    });
  }
  return colorTransformBuildJobScheduler;
}

function getColorTransformWorkerClient(): ColorTransformWorkerClient | null {
  if (colorTransformWorkerClient !== undefined) {
    return colorTransformWorkerClient;
  }

  if (typeof Worker === "undefined") {
    colorTransformWorkerFallbackReason = "worker-unavailable";
    colorTransformWorkerClient = null;
    return colorTransformWorkerClient;
  }

  try {
    colorTransformWorkerClient = new ColorTransformWorkerClient();
    colorTransformWorkerFallbackReason = null;
  } catch {
    colorTransformWorkerFallbackReason = "worker-construction-failed";
    colorTransformWorkerClient = null;
  }
  return colorTransformWorkerClient;
}

export function disposeViewport3DColorTransformWorker(): void {
  colorTransformBuildJobScheduler?.dispose();
  colorTransformBuildJobScheduler = undefined;
  colorTransformWorkerClient?.dispose();
  colorTransformWorkerClient = undefined;
  colorTransformWorkerFallbackReason = undefined;
}

/** @deprecated Use disposeViewport3DColorTransformWorker. */
export const disposeViewport3DColorTransformWorkerForTests =
  disposeViewport3DColorTransformWorker;

export function getViewport3DColorTransformWorkerRuntimeCounts(): { timers: number; workers: number } {
  return colorTransformWorkerClient?.getRuntimeCounts() ?? { timers: 0, workers: 0 };
}
export function getViewport3DColorTransformPendingJobCount(): number { return colorTransformBuildJobScheduler?.getPendingJobCount() ?? 0; }

function estimateFieldColorInputBytes(
  fieldVector: Viewport3DFieldVector,
  target: Viewport3DFieldColorBuildTarget | undefined,
): number {
  return estimateViewport3DFieldColorBuildInputBytes({
    fieldVector,
    target: target ?? defaultFieldColorTarget(fieldVector),
  });
}

function estimateFieldColorOutputBytes(
  fieldVector: Viewport3DFieldVector,
  options: Viewport3DColorTransformBuildOptions,
): number {
  return estimateViewport3DFieldColorBuildOutputBytes({
    colorMode: options.colorMode,
    fieldVector,
    shaderOnly: options.shaderOnly,
    target: options.target ?? defaultFieldColorTarget(fieldVector),
  });
}

function defaultFieldColorTarget(
  fieldVector: Viewport3DFieldVector,
): Viewport3DFieldColorBuildTarget {
  return {
    kind: "full-domain",
    vertexCount: fieldVector.pointCount,
  };
}

function isWorkerTransferableFieldVector(
  fieldVector: Viewport3DFieldVector,
): boolean {
  return (
    (fieldVector.dtype === "float32" && fieldVector.values instanceof Float32Array) ||
    (fieldVector.dtype === "float64" && fieldVector.values instanceof Float64Array)
  );
}

function cloneFieldColorBuildTargetForWorker(
  target: Viewport3DFieldColorBuildTarget,
): {
  target: Viewport3DFieldColorBuildTarget;
  transferables: Transferable[];
} {
  switch (target.kind) {
    case "mapped-vertices": {
      const targetNodeIndices = new Uint32Array(target.targetNodeIndices);
      return {
        target: {
          ...target,
          targetNodeIndices,
        },
        transferables: [targetNodeIndices.buffer],
      };
    }
    case "sampled": {
      const pointIndices = new Uint32Array(target.pointIndices);
      return {
        target: {
          ...target,
          pointIndices,
        },
        transferables: [pointIndices.buffer],
      };
    }
    case "fdm-sampled": {
      const cellOrdinals = new Uint32Array(target.cellOrdinals);
      return {
        target: {
          ...target,
          cellOrdinals,
        },
        transferables: [cellOrdinals.buffer],
      };
    }
    case "surface-faces": {
      const surfaceIndices = new Uint32Array(target.surfaceIndices);
      const targetNodeIndices = target.targetNodeIndices
        ? new Uint32Array(target.targetNodeIndices)
        : undefined;
      return {
        target: {
          ...target,
          surfaceIndices,
          ...(targetNodeIndices ? { targetNodeIndices } : {}),
        },
        transferables: [
          surfaceIndices.buffer,
          ...(targetNodeIndices ? [targetNodeIndices.buffer] : []),
        ],
      };
    }
    case "thickness-average-z": {
      const positions = new Float32Array(target.positions);
      const surfaceIndices = new Uint32Array(target.surfaceIndices);
      const targetNodeIndices = target.targetNodeIndices
        ? new Uint32Array(target.targetNodeIndices)
        : undefined;
      return {
        target: {
          ...target,
          positions,
          surfaceIndices,
          ...(targetNodeIndices ? { targetNodeIndices } : {}),
        },
        transferables: [
          positions.buffer,
          surfaceIndices.buffer,
          ...(targetNodeIndices ? [targetNodeIndices.buffer] : []),
        ],
      };
    }
    case "full-domain":
      return { target, transferables: [] };
  }
}

class ColorTransformWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingColorTransform>();
  private readonly queuedIds: number[] = [];
  private readonly worker: Worker;
  private activeId: number | null = null;

  constructor() {
    this.worker = new Worker(
      new URL(
        "./field-colors/viewport3dFieldColorBuildWorker.ts",
        import.meta.url,
      ),
      {
        name: "fullmag-viewport3d-field-color-build",
        type: "module",
      },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  transform(
    fieldVector: Viewport3DFieldVector,
    options: Viewport3DColorTransformBuildOptions,
  ): Promise<ScalarColorBuffer> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Viewport 3D color transform worker has been disposed."),
      );
    }
    throwIfAborted(options.signal);
    this.clearIdleDisposeTimer();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const signal = options.signal ?? null;
      const abortListener = signal
        ? () => {
            this.abortPending(id);
          }
        : null;
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(id, {
        abortListener,
        fieldVector,
        options,
        reject,
        resolve,
        signal,
      });
      this.queuedIds.push(id);
      this.dispatchNext();
    });
  }

  dispose(reason?: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleDisposeTimer();
    this.activeId = null;
    this.queuedIds.length = 0;
    const error =
      reason instanceof Error
        ? reason
        : new Error("Viewport 3D color transform worker has been disposed.");
    for (const id of this.pending.keys()) {
      const pending = this.clearPending(id);
      pending?.reject(error);
    }
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleError);
    this.worker.terminate();
    if (colorTransformWorkerClient === this) {
      colorTransformWorkerClient = undefined;
    }
  }

  getRuntimeCounts(): { timers: number; workers: number } {
    return { timers: this.idleTimeoutId === null ? 0 : 1, workers: this.disposed ? 0 : 1 };
  }

  private dispatchNext(): void {
    if (this.disposed || this.activeId !== null) return;
    this.clearIdleDisposeTimer();

    while (this.queuedIds.length > 0) {
      const id = this.queuedIds.shift();
      if (id === undefined) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      if (pending.signal?.aborted) {
        this.clearPending(id)?.reject(createAbortError());
        continue;
      }

      const { fieldVector, options } = pending;
      let values: Float32Array | Float64Array;
      let transferables: Transferable[];
      let request: Viewport3DFieldColorBuildWorkerRequest;
      try {
        values =
          fieldVector.values instanceof Float32Array
            ? new Float32Array(fieldVector.values)
            : new Float64Array(fieldVector.values);
        const target = cloneFieldColorBuildTargetForWorker(
          options.target ?? defaultFieldColorTarget(fieldVector),
        );
        transferables = [values.buffer, ...target.transferables];
        request = {
          chunkSize: options.chunkSize,
          colorMode: options.colorMode,
          colorPalette: options.colorPalette,
          fieldVector: {
            ...fieldVector,
            values,
          },
          id,
          scalarRange: options.scalarRange,
          shaderOnly: options.shaderOnly,
          target: target.target,
        };
      } catch (error) {
        this.clearPending(id)?.reject(error);
        continue;
      }

      this.activeId = id;
      try {
        this.worker.postMessage(request, transferables);
      } catch (error) {
        this.activeId = null;
        const failed = this.clearPending(id);
        this.dispose(error);
        failed?.reject(error);
      }
      return;
    }
    this.scheduleIdleDispose();
  }

  private readonly handleMessage = (
    event: MessageEvent<Viewport3DFieldColorBuildWorkerResponse>,
  ): void => {
    if (this.disposed) return;
    const response = event.data;
    if (response.id !== this.activeId) return;
    this.activeId = null;
    const pending = this.clearPending(response.id);
    if (pending) {
      if (response.ok) {
        pending.resolve(response.data);
      } else {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        pending.reject(error);
      }
    }
    this.dispatchNext();
  };

  private readonly handleError = (event: Event): void => {
    const message =
      typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent
        ? event.message
        : "Viewport 3D color transform worker failed.";
    const error = new Error(message);
    error.name = "Viewport3DColorTransformWorkerError";
    this.dispose(error);
  };

  private clearPending(id: number): PendingColorTransform | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private abortPending(id: number): void {
    if (this.activeId === id) {
      const pending = this.clearPending(id);
      pending?.reject(createAbortError());
      return;
    }
    const queuedIndex = this.queuedIds.indexOf(id);
    if (queuedIndex >= 0) this.queuedIds.splice(queuedIndex, 1);
    const pending = this.clearPending(id);
    if (!pending) return;
    pending.reject(createAbortError());
    this.dispatchNext();
  }

  private scheduleIdleDispose(): void {
    if (
      this.activeId !== null ||
      this.queuedIds.length > 0 ||
      this.pending.size > 0 ||
      this.idleTimeoutId !== null
    ) return;
    this.idleTimeoutId = setTimeout(() => {
      this.idleTimeoutId = null;
      this.dispose();
    }, COLOR_TRANSFORM_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleDisposeTimer(): void {
    if (this.idleTimeoutId === null) return;
    clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = null;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Field transform aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}
