import { decodeFieldVector } from "./fieldVectorCodec";
import { decodeTopology } from "./topologyCodec";
import type { DecodedFieldVector, DecodedTopology } from "./types";
import { decodedPayloadTransferList } from "./transferables";

type BinaryDecodeWorkerRequest =
  | {
      id: number;
      kind: "field-vector";
      buffer: ArrayBuffer;
    }
  | {
      id: number;
      kind: "topology";
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

interface BinaryDecodeWorkerScope {
  postMessage: (
    message: BinaryDecodeWorkerResponse,
    transfer?: Transferable[],
  ) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<BinaryDecodeWorkerRequest>) => void,
  ) => void;
}

const workerScope = self as unknown as BinaryDecodeWorkerScope;

workerScope.addEventListener("message", (event: MessageEvent<BinaryDecodeWorkerRequest>) => {
  const request = event.data;
  try {
    const payload =
      request.kind === "field-vector"
        ? decodeFieldVector(request.buffer)
        : decodeTopology(request.buffer);
    const response: BinaryDecodeWorkerResponse = {
      id: request.id,
      ok: true,
      payload,
    };
    workerScope.postMessage(response, decodedPayloadTransferList(payload));
  } catch (error) {
    const response: BinaryDecodeWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
});

export {};
