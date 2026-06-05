"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildVertexScalarColorsChunked,
  type ChunkedFieldTransformOptions,
  type ScalarColorBuffer,
} from "./viewport3dFieldMapping";

interface ColorTransformWorkerRequest {
  fieldVector: DecodedFieldVector;
  id: number;
  options: Pick<
    ChunkedFieldTransformOptions,
    "chunkSize" | "colorMode" | "colorPalette" | "shaderOnly"
  >;
}

interface ColorTransformWorkerOkResponse {
  data: ScalarColorBuffer;
  id: number;
  ok: true;
}

interface ColorTransformWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

type ColorTransformWorkerResponse =
  | ColorTransformWorkerErrorResponse
  | ColorTransformWorkerOkResponse;

interface PendingColorTransform {
  abortListener: (() => void) | null;
  reject: (reason: unknown) => void;
  resolve: (value: ScalarColorBuffer) => void;
  signal: AbortSignal | null;
}

const COLOR_TRANSFORM_WORKER_IDLE_TIMEOUT_MS = 30_000;

let colorTransformWorkerClient:
  | ColorTransformWorkerClient
  | null
  | undefined;

export async function buildVertexScalarColorsOffMainThread(
  fieldVector: DecodedFieldVector,
  options: ChunkedFieldTransformOptions = {},
): Promise<ScalarColorBuffer> {
  throwIfAborted(options.signal);
  const client = getColorTransformWorkerClient();
  if (client) {
    try {
      return await client.transform(fieldVector, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      colorTransformWorkerClient = null;
    }
  }

  return buildVertexScalarColorsChunked(fieldVector, options);
}

export function disposeViewport3DColorTransformWorkerForTests(): void {
  colorTransformWorkerClient?.dispose();
  colorTransformWorkerClient = undefined;
}

function getColorTransformWorkerClient(): ColorTransformWorkerClient | null {
  if (colorTransformWorkerClient !== undefined) {
    return colorTransformWorkerClient;
  }

  if (typeof Worker === "undefined") {
    colorTransformWorkerClient = null;
    return colorTransformWorkerClient;
  }

  try {
    colorTransformWorkerClient = new ColorTransformWorkerClient();
  } catch {
    colorTransformWorkerClient = null;
  }
  return colorTransformWorkerClient;
}

class ColorTransformWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingColorTransform>();
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(
      new URL("./viewport3dColorTransformWorker.ts", import.meta.url),
      {
        name: "fullmag-viewport3d-color-transform",
        type: "module",
      },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  transform(
    fieldVector: DecodedFieldVector,
    options: ChunkedFieldTransformOptions,
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
    const request: ColorTransformWorkerRequest = {
      fieldVector: {
        ...fieldVector,
        values,
      },
      id,
      options: {
        chunkSize: options.chunkSize,
        colorMode: options.colorMode,
        colorPalette: options.colorPalette,
        shaderOnly: options.shaderOnly,
      },
    };

    return new Promise((resolve, reject) => {
      const signal = options.signal ?? null;
      const abortListener = signal
        ? () => {
            this.pending.delete(id);
            reject(createAbortError());
            this.dispose(createAbortError());
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
        this.worker.postMessage(request, [values.buffer]);
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
    event: MessageEvent<ColorTransformWorkerResponse>,
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
