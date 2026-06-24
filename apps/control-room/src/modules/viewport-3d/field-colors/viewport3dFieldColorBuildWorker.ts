import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import {
  buildViewport3DFieldColorBuffer,
  type Viewport3DFieldColorBuildModelInput,
} from "./viewport3dFieldColorBuildModel";

export type Viewport3DFieldColorBuildWorkerRequest = Omit<
  Viewport3DFieldColorBuildModelInput,
  "signal" | "yieldToMain"
> & {
  id: number;
};

export interface Viewport3DFieldColorBuildWorkerOkResponse {
  data: ScalarColorBuffer;
  id: number;
  ok: true;
}

export interface Viewport3DFieldColorBuildWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

export type Viewport3DFieldColorBuildWorkerResponse =
  | Viewport3DFieldColorBuildWorkerErrorResponse
  | Viewport3DFieldColorBuildWorkerOkResponse;

interface Viewport3DFieldColorBuildWorkerScope {
  addEventListener(
    type: "message",
    listener: (
      event: MessageEvent<Viewport3DFieldColorBuildWorkerRequest>,
    ) => void,
  ): void;
  postMessage(
    message: Viewport3DFieldColorBuildWorkerResponse,
    transfer?: Transferable[],
  ): void;
}

export function installViewport3DFieldColorBuildWorker(
  workerScope: Viewport3DFieldColorBuildWorkerScope,
): void {
  workerScope.addEventListener(
    "message",
    (event: MessageEvent<Viewport3DFieldColorBuildWorkerRequest>) => {
      const { id, ...request } = event.data;
      void buildViewport3DFieldColorBuffer(request)
        .then((data) => {
          if (!data) {
            throw new Error(
              "Viewport 3D field-color worker returned no buffer.",
            );
          }
          workerScope.postMessage(
            { data, id, ok: true },
            transferablesForViewport3DFieldColorBuffer(data),
          );
        })
        .catch((error) => {
          workerScope.postMessage({
            error: serializeError(error),
            id,
            ok: false,
          });
        });
    },
  );
}

export function transferablesForViewport3DFieldColorBuffer(
  buffer: ScalarColorBuffer,
): Transferable[] {
  const transferables: Transferable[] = [];
  addArrayBufferTransferable(transferables, buffer.colors.buffer);
  addArrayBufferTransferable(transferables, buffer.scalarValues?.buffer);
  addArrayBufferTransferable(transferables, buffer.vectorValues?.buffer);
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

function serializeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: String(error),
    name: "Error",
  };
}

function isWorkerScope(scope: typeof globalThis): boolean {
  return (
    typeof (scope as { document?: unknown }).document === "undefined" &&
    typeof (scope as { addEventListener?: unknown }).addEventListener ===
      "function" &&
    typeof (scope as { postMessage?: unknown }).postMessage === "function"
  );
}

if (isWorkerScope(globalThis)) {
  installViewport3DFieldColorBuildWorker(
    globalThis as unknown as Viewport3DFieldColorBuildWorkerScope,
  );
}
