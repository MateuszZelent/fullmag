import {
  decodeBinaryPayload,
  transferablesForDecodedPayload,
  type BinaryDecoderKind,
} from "./binaryDecodePayload";

interface BinaryDecodeWorkerRequest {
  buffer: ArrayBuffer;
  id: number;
  kind: BinaryDecoderKind;
}

interface BinaryDecodeWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<BinaryDecodeWorkerRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as BinaryDecodeWorkerScope;

workerScope.addEventListener(
  "message",
  (event: MessageEvent<BinaryDecodeWorkerRequest>) => {
    const { buffer, id, kind } = event.data;
    try {
      const data = decodeBinaryPayload(kind, buffer);
      workerScope.postMessage(
        { data, id, ok: true },
        transferablesForDecodedPayload(data),
      );
    } catch (error) {
      workerScope.postMessage({
        error: serializeError(error),
        id,
        ok: false,
      });
    }
  },
);

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
