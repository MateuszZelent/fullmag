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

interface ColorTransformWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ColorTransformWorkerRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as ColorTransformWorkerScope;

workerScope.addEventListener(
  "message",
  (event: MessageEvent<ColorTransformWorkerRequest>) => {
    const { fieldVector, id, options } = event.data;
    void buildVertexScalarColorsChunked(fieldVector, options)
      .then((data) => {
        workerScope.postMessage(
          { data, id, ok: true },
          transferablesForScalarColorBuffer(data),
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

function transferablesForScalarColorBuffer(
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
