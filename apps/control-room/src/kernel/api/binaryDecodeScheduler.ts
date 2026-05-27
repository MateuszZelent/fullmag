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
    const id = this.nextId++;
    const message: BinaryDecodeWorkerRequest = { buffer, id, kind };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        this.worker.postMessage(message, [buffer]);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private readonly handleMessage = (
    event: MessageEvent<BinaryDecodeWorkerResponse>,
  ): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.data);
      return;
    }

    const error = new Error(response.error.message);
    error.name = response.error.name;
    pending.reject(error);
  };

  private readonly handleError = (event: Event): void => {
    const message =
      event instanceof ErrorEvent ? event.message : "Binary decode worker failed.";
    const error = new Error(message);
    error.name = "BinaryDecodeWorkerError";
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    workerClient = null;
  };
}
