"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

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
} from "./viewport3dFieldMapping";

export interface Viewport3DColorTransformBuildOptions
  extends ChunkedFieldTransformOptions {
  buildKey?: string;
  groupKey?: string;
  latestWins?: boolean;
  onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  revisionSummary?: string;
  target?: Viewport3DFieldColorBuildTarget;
}

interface PendingColorTransform {
  abortListener: (() => void) | null;
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
  fieldVector: DecodedFieldVector,
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
  fieldVector: DecodedFieldVector,
  options: Viewport3DColorTransformBuildExecutionOptions = {},
): Promise<ScalarColorBuffer> {
  throwIfAborted(options.signal);
  const client = getColorTransformWorkerClient();
  if (client) {
    try {
      return await client.transform(fieldVector, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      colorTransformWorkerFallbackReason = "worker-error";
      options.recordFallback?.(colorTransformWorkerFallbackReason);
      colorTransformWorkerClient = null;
    }
  } else {
    options.recordFallback?.(
      colorTransformWorkerFallbackReason ?? "worker-unavailable",
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

export function disposeViewport3DColorTransformWorkerForTests(): void {
  colorTransformBuildJobScheduler?.dispose();
  colorTransformBuildJobScheduler = undefined;
  colorTransformWorkerClient?.dispose();
  colorTransformWorkerClient = undefined;
  colorTransformWorkerFallbackReason = undefined;
}

function estimateFieldColorInputBytes(
  fieldVector: DecodedFieldVector,
  target: Viewport3DFieldColorBuildTarget | undefined,
): number {
  return estimateViewport3DFieldColorBuildInputBytes({
    fieldVector,
    target: target ?? defaultFieldColorTarget(fieldVector),
  });
}

function estimateFieldColorOutputBytes(
  fieldVector: DecodedFieldVector,
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
  fieldVector: DecodedFieldVector,
): Viewport3DFieldColorBuildTarget {
  return {
    kind: "full-domain",
    vertexCount: fieldVector.pointCount,
  };
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
    case "full-domain":
      return { target, transferables: [] };
  }
}

class ColorTransformWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingColorTransform>();
  private readonly worker: Worker;

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
    fieldVector: DecodedFieldVector,
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
    const values = new Float64Array(fieldVector.values);
    const target = cloneFieldColorBuildTargetForWorker(
      options.target ?? defaultFieldColorTarget(fieldVector),
    );
    const request: Viewport3DFieldColorBuildWorkerRequest = {
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
        reject,
        resolve,
        signal,
      });
      try {
        this.worker.postMessage(request, [values.buffer, ...target.transferables]);
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

  private readonly handleMessage = (
    event: MessageEvent<Viewport3DFieldColorBuildWorkerResponse>,
  ): void => {
    if (this.disposed) return;
    const response = event.data;
    const pending = this.clearPending(response.id);
    if (!pending) {
      return;
    }

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
    const pending = this.clearPending(id);
    if (!pending) return;
    pending.reject(createAbortError());
    this.scheduleIdleDispose();
  }

  private scheduleIdleDispose(): void {
    if (this.pending.size > 0 || this.idleTimeoutId !== null) return;
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
