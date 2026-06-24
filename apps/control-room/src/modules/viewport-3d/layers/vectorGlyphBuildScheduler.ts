import {
  buildViewport3DVectorGlyphs,
  type VectorGlyphBuildRequest,
  type VectorGlyphBuildResult,
} from "./vectorGlyphBuildModel";
import {
  createViewport3DWorkerPool,
  type Viewport3DWorkerPool,
  type Viewport3DWorkerPoolLease,
} from "../build-engine/workerPool/viewport3dWorkerPool";
import type { Viewport3DBuildDiagnosticRecord } from "../build-engine/viewport3dBuildEngineTypes";
import { recordViewport3DBuildDiagnostic } from "../build-engine/viewport3dBuildDiagnostics";
import { createViewport3DBuildScheduler } from "../build-engine/viewport3dBuildScheduler";

export type {
  VectorGlyphBuildRequest,
  VectorGlyphBuildResult,
} from "./vectorGlyphBuildModel";

export interface VectorGlyphBuildOptions {
  buildKey?: string;
  groupKey?: string;
  latestWins?: boolean;
  onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  revisionSummary?: string;
  signal?: AbortSignal;
}

interface VectorGlyphBuildExecutionOptions extends VectorGlyphBuildOptions {
  recordFallback?: (reason: string) => void;
}

interface VectorGlyphWorkerRequest extends VectorGlyphBuildRequest {
  id: number;
}

interface VectorGlyphWorkerOkResponse {
  data: VectorGlyphBuildResult;
  id: number;
  ok: true;
}

interface VectorGlyphWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

type VectorGlyphWorkerResponse =
  | VectorGlyphWorkerErrorResponse
  | VectorGlyphWorkerOkResponse;

interface PendingVectorGlyphBuild {
  abortListener: (() => void) | null;
  lease: Viewport3DWorkerPoolLease<Worker>;
  reject: (reason: unknown) => void;
  resolve: (value: VectorGlyphBuildResult) => void;
  signal: AbortSignal | null;
}

const VECTOR_GLYPH_WORKER_IDLE_TIMEOUT_MS = 30_000;
const VECTOR_GLYPH_WORKER_POOL_SIZE = 2;

let fallbackVectorGlyphBuildId = 1;
let vectorGlyphBuildJobScheduler:
  | ReturnType<typeof createViewport3DBuildScheduler>
  | undefined;
let vectorGlyphWorkerClient: VectorGlyphWorkerClient | null | undefined;
let vectorGlyphWorkerFallbackReason: string | null | undefined;

export async function buildViewport3DVectorGlyphsOffMainThread(
  request: VectorGlyphBuildRequest,
  options: VectorGlyphBuildOptions = {},
): Promise<VectorGlyphBuildResult> {
  throwIfAborted(options.signal);
  const buildKey =
    options.buildKey ?? `vector-glyph:adhoc:${fallbackVectorGlyphBuildId++}`;
  const scheduler = getVectorGlyphBuildJobScheduler();
  return scheduler.schedule(
    {
      groupKey: options.groupKey,
      inputBytes: request.segments.byteLength,
      itemCount: Math.floor(request.segments.length / 7),
      key: buildKey,
      lane: "vector-glyph",
      outputBytesEstimate: request.segments.byteLength * 4,
      revisionSummary: options.revisionSummary ?? buildKey,
    },
    (_buildRequest, context) =>
      executeVectorGlyphBuild(request, {
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

async function executeVectorGlyphBuild(
  request: VectorGlyphBuildRequest,
  options: VectorGlyphBuildExecutionOptions,
): Promise<VectorGlyphBuildResult> {
  throwIfAborted(options.signal);
  const client = getVectorGlyphWorkerClient();
  if (client) {
    try {
      return await client.build(request, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      vectorGlyphWorkerFallbackReason = "worker-error";
      options.recordFallback?.(vectorGlyphWorkerFallbackReason);
      vectorGlyphWorkerClient = null;
    }
  } else {
    options.recordFallback?.(
      vectorGlyphWorkerFallbackReason ?? "worker-unavailable",
    );
  }

  return buildViewport3DVectorGlyphs(request);
}

export function disposeVectorGlyphBuildWorkerForTests(): void {
  vectorGlyphBuildJobScheduler?.dispose();
  vectorGlyphBuildJobScheduler = undefined;
  vectorGlyphWorkerClient?.dispose();
  vectorGlyphWorkerClient = undefined;
  vectorGlyphWorkerFallbackReason = undefined;
}

function getVectorGlyphBuildJobScheduler(): ReturnType<
  typeof createViewport3DBuildScheduler
> {
  if (!vectorGlyphBuildJobScheduler) {
    vectorGlyphBuildJobScheduler = createViewport3DBuildScheduler({
      laneConcurrency: {
        "vector-glyph": 2,
      },
      onDiagnosticRecord: recordViewport3DBuildDiagnostic,
    });
  }
  return vectorGlyphBuildJobScheduler;
}

function getVectorGlyphWorkerClient(): VectorGlyphWorkerClient | null {
  if (vectorGlyphWorkerClient !== undefined) {
    return vectorGlyphWorkerClient;
  }

  if (typeof Worker === "undefined") {
    vectorGlyphWorkerFallbackReason = "worker-unavailable";
    vectorGlyphWorkerClient = null;
    return vectorGlyphWorkerClient;
  }

  try {
    vectorGlyphWorkerClient = new VectorGlyphWorkerClient();
    vectorGlyphWorkerFallbackReason = null;
  } catch {
    vectorGlyphWorkerFallbackReason = "worker-construction-failed";
    vectorGlyphWorkerClient = null;
  }
  return vectorGlyphWorkerClient;
}

class VectorGlyphWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingVectorGlyphBuild>();
  private readonly pool: Viewport3DWorkerPool<Worker>;
  private readonly workers = new Set<Worker>();

  constructor() {
    this.pool = createViewport3DWorkerPool({
      createWorker: () => this.createWorker(),
      maxWorkers: VECTOR_GLYPH_WORKER_POOL_SIZE,
    });
  }

  build(
    input: VectorGlyphBuildRequest,
    options: VectorGlyphBuildOptions,
  ): Promise<VectorGlyphBuildResult> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Viewport 3D vector glyph worker has been disposed."),
      );
    }
    throwIfAborted(options.signal);
    this.clearIdleDisposeTimer();
    const id = this.nextId++;
    const segments = new Float32Array(input.segments);
    const request: VectorGlyphWorkerRequest = {
      colorMode: input.colorMode,
      headLengthRatio: input.headLengthRatio,
      headRadiusRatio: input.headRadiusRatio,
      id,
      segments,
      shaftRadiusRatio: input.shaftRadiusRatio,
    };
    const transferables: Transferable[] = [];
    addArrayBufferTransferable(transferables, segments.buffer);

    return new Promise((resolve, reject) => {
      let lease: Viewport3DWorkerPoolLease<Worker>;
      try {
        lease = this.pool.acquire();
      } catch (error) {
        reject(error);
        return;
      }
      const signal = options.signal ?? null;
      const abortListener = signal ? () => this.abortPending(id) : null;
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(id, {
        abortListener,
        lease,
        reject,
        resolve,
        signal,
      });
      try {
        lease.worker.postMessage(request, transferables);
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
        : new Error("Viewport 3D vector glyph worker has been disposed.");
    for (const id of this.pending.keys()) {
      const pending = this.clearPending(id);
      pending?.reject(error);
    }
    for (const worker of this.workers) {
      worker.removeEventListener("message", this.handleMessage);
      worker.removeEventListener("error", this.handleError);
      worker.removeEventListener("messageerror", this.handleError);
    }
    this.pool.dispose();
    this.workers.clear();
    if (vectorGlyphWorkerClient === this) {
      vectorGlyphWorkerClient = undefined;
    }
  }

  private readonly handleMessage = (
    event: MessageEvent<VectorGlyphWorkerResponse>,
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
        : "Viewport 3D vector glyph worker failed.";
    const error = new Error(message);
    error.name = "Viewport3DVectorGlyphWorkerError";
    this.dispose(error);
  };

  private clearPending(id: number): PendingVectorGlyphBuild | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    pending.lease.release();
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL("./vectorGlyphBuildWorker.ts", import.meta.url),
      {
        name: "fullmag-viewport3d-vector-glyph-build",
        type: "module",
      },
    );
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleError);
    worker.addEventListener("messageerror", this.handleError);
    this.workers.add(worker);
    return worker;
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
    }, VECTOR_GLYPH_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleDisposeTimer(): void {
    if (this.idleTimeoutId === null) return;
    clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = null;
  }
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
  const error = new Error("Vector glyph build aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "Vector glyph build aborted")
  );
}
