import { decodeFieldVector } from "./fieldVectorCodec";
import { decodeTopology } from "./topologyCodec";
import type { DecodedFieldVector, DecodedTopology } from "./types";
import { arrayBufferTransferList } from "./transferables";

type DecodeKind = "field-vector" | "topology";

type BinaryDecodeWorkerRequest = {
  id: number;
  kind: DecodeKind;
  buffer: ArrayBuffer;
};

type BinaryDecodeWorkerResponse =
  | {
      id: number;
      ok: true;
      payload: DecodedFieldVector | DecodedTopology;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

type PendingDecode = {
  resolve: (value: DecodedFieldVector | DecodedTopology) => void;
  reject: (reason?: unknown) => void;
};

interface DecodeOffThreadOptions {
  transferInput?: boolean;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingDecode>();
let workerDisabled = false;

function decodeOnMainThread(
  kind: DecodeKind,
  buffer: ArrayBuffer,
): DecodedFieldVector | DecodedTopology {
  return kind === "field-vector"
    ? decodeFieldVector(buffer)
    : decodeTopology(buffer);
}

function destroyWorker(): void {
  worker?.terminate();
  worker = null;
}

function disableWorker(reason?: unknown): void {
  workerDisabled = true;
  destroyWorker();
  const error =
    reason instanceof Error
      ? reason
      : new Error(
          typeof reason === "string"
            ? reason
            : "binary decode worker disabled",
        );
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (workerDisabled || typeof Worker === "undefined") {
    return null;
  }
  if (worker) {
    return worker;
  }

  const created = new Worker(new URL("./binaryDecode.worker.ts", import.meta.url), {
    type: "module",
  });

  created.onmessage = (event: MessageEvent<BinaryDecodeWorkerResponse>) => {
    const response = event.data;
    const active = pending.get(response.id);
    if (!active) {
      return;
    }
    pending.delete(response.id);
    if (response.ok) {
      active.resolve(response.payload);
      return;
    }
    active.reject(new Error(response.error));
  };

  created.onerror = (event) => {
    disableWorker(event.error ?? event.message);
  };

  worker = created;
  return worker;
}

async function decodeWithWorker<T extends DecodedFieldVector | DecodedTopology>(
  kind: DecodeKind,
  buffer: ArrayBuffer,
  options?: DecodeOffThreadOptions,
): Promise<T> {
  const activeWorker = ensureWorker();
  if (!activeWorker) {
    return decodeOnMainThread(kind, buffer) as T;
  }

  return new Promise<T>((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject: (reason) => reject(reason),
    });
    try {
      activeWorker.postMessage(
        { id, kind, buffer } satisfies BinaryDecodeWorkerRequest,
        options?.transferInput ? arrayBufferTransferList(buffer) : [],
      );
    } catch (error) {
      pending.delete(id);
      try {
        resolve(decodeOnMainThread(kind, buffer) as T);
      } catch {
        reject(error);
      }
    }
  });
}

export function decodeFieldVectorOffThread(
  buffer: ArrayBuffer,
  options?: DecodeOffThreadOptions,
): Promise<DecodedFieldVector> {
  return decodeWithWorker<DecodedFieldVector>("field-vector", buffer, options);
}

export function decodeTopologyOffThread(
  buffer: ArrayBuffer,
  options?: DecodeOffThreadOptions,
): Promise<DecodedTopology> {
  return decodeWithWorker<DecodedTopology>("topology", buffer, options);
}
