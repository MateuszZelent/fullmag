import type { BinaryDecodedPayload, BinaryDecoderKind } from "./binaryDecodePayload";

export type { BinaryDecoderKind } from "./binaryDecodePayload";

interface BinaryDecodeTask<TData> {
  buffer: ArrayBuffer;
  decodeInline: (buffer: ArrayBuffer) => TData;
  kind: BinaryDecoderKind;
  path: string;
}

export type BinaryDecodeScheduler = <TData>(
  task: BinaryDecodeTask<TData>,
) => Promise<TData> | TData;

interface BinaryDecodeWorkerRequest {
  buffer: ArrayBuffer;
  id: number;
  kind: BinaryDecoderKind;
}

interface BinaryDecodeWorkerOkResponse {
  data: BinaryDecodedPayload;
  id: number;
  ok: true;
}

interface BinaryDecodeWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

type BinaryDecodeWorkerResponse =
  | BinaryDecodeWorkerErrorResponse
  | BinaryDecodeWorkerOkResponse;

const BINARY_DECODE_WORKER_IDLE_TIMEOUT_MS = 30_000;

interface PendingDecode {
  reject: (reason: unknown) => void;
  resolve: (value: BinaryDecodedPayload) => void;
}

let workerClient: BinaryDecodeWorkerClient | null | undefined;

export function createBinaryDecodeScheduler(): BinaryDecodeScheduler {
  return async <TData>({ buffer, decodeInline, kind }: BinaryDecodeTask<TData>) => {
    const client = getBinaryDecodeWorkerClient();
    if (client) {
      return (await client.decode(kind, buffer)) as TData;
    }

    return decodeInline(buffer);
  };
}

export function disposeBinaryDecodeWorkerForTests(): void {
  workerClient?.dispose();
  workerClient = undefined;
}

function getBinaryDecodeWorkerClient(): BinaryDecodeWorkerClient | null {
  if (workerClient !== undefined) {
    return workerClient;
  }

  if (typeof Worker === "undefined") {
    workerClient = null;
    return workerClient;
  }

  try {
    workerClient = new BinaryDecodeWorkerClient();
  } catch {
    workerClient = null;
  }
  return workerClient;
}

class BinaryDecodeWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingDecode>();
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(new URL("./binaryDecodeWorker.ts", import.meta.url), {
      name: "fullmag-binary-decode",
      type: "module",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  decode(kind: BinaryDecoderKind, buffer: ArrayBuffer): Promise<BinaryDecodedPayload> {
    if (this.disposed) {
      return Promise.reject(new Error("Binary decode worker has been disposed."));
    }
    this.clearIdleDisposeTimer();
    const id = this.nextId++;
    const message: BinaryDecodeWorkerRequest = { buffer, id, kind };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        this.worker.postMessage(message, [buffer]);
      } catch (error) {
        this.pending.delete(id);
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
        : new Error("Binary decode worker has been disposed.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleError);
    this.worker.terminate();
    if (workerClient === this) {
      workerClient = undefined;
    }
  }

  private readonly handleMessage = (
    event: MessageEvent<BinaryDecodeWorkerResponse>,
  ): void => {
    if (this.disposed) return;
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
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
        : "Binary decode worker failed.";
    const error = new Error(message);
    error.name = "BinaryDecodeWorkerError";
    this.dispose(error);
  };

  private scheduleIdleDispose(): void {
    if (this.pending.size > 0 || this.idleTimeoutId !== null) return;
    this.idleTimeoutId = setTimeout(() => {
      this.idleTimeoutId = null;
      this.dispose();
    }, BINARY_DECODE_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleDisposeTimer(): void {
    if (this.idleTimeoutId === null) return;
    clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = null;
  }
}
