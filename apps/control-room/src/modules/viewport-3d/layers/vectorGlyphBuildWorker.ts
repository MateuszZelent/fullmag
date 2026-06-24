import {
  buildViewport3DVectorGlyphs,
  transferablesForVectorGlyphBuildResult,
  type VectorGlyphBuildRequest,
} from "./vectorGlyphBuildModel";

interface VectorGlyphWorkerRequest extends VectorGlyphBuildRequest {
  id: number;
}

interface VectorGlyphWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<VectorGlyphWorkerRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as VectorGlyphWorkerScope;

workerScope.addEventListener(
  "message",
  (event: MessageEvent<VectorGlyphWorkerRequest>) => {
    const { id, ...request } = event.data;
    try {
      const result = buildViewport3DVectorGlyphs(request);
      workerScope.postMessage(
        { data: result, id, ok: true },
        transferablesForVectorGlyphBuildResult(result),
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
