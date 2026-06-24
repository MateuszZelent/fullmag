import {
  buildViewport3DRegionOverlayModels,
  transferablesForViewport3DRegionOverlayBuildResult,
  type Viewport3DRegionOverlayBuildRequest,
  type Viewport3DRegionOverlayBuildResult,
} from "./viewport3dRegionOverlayBuildModel";

export type Viewport3DRegionOverlayBuildWorkerRequest =
  Viewport3DRegionOverlayBuildRequest & {
    id: number;
  };

export interface Viewport3DRegionOverlayBuildWorkerOkResponse {
  data: Viewport3DRegionOverlayBuildResult;
  id: number;
  ok: true;
}

export interface Viewport3DRegionOverlayBuildWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

export type Viewport3DRegionOverlayBuildWorkerResponse =
  | Viewport3DRegionOverlayBuildWorkerErrorResponse
  | Viewport3DRegionOverlayBuildWorkerOkResponse;

interface Viewport3DRegionOverlayBuildWorkerScope {
  addEventListener(
    type: "message",
    listener: (
      event: MessageEvent<Viewport3DRegionOverlayBuildWorkerRequest>,
    ) => void,
  ): void;
  postMessage(
    message: Viewport3DRegionOverlayBuildWorkerResponse,
    transfer?: Transferable[],
  ): void;
}

export function installViewport3DRegionOverlayBuildWorker(
  workerScope: Viewport3DRegionOverlayBuildWorkerScope,
): void {
  workerScope.addEventListener(
    "message",
    (event: MessageEvent<Viewport3DRegionOverlayBuildWorkerRequest>) => {
      const { id, ...request } = event.data;
      try {
        const data = buildViewport3DRegionOverlayModels(request);
        workerScope.postMessage(
          { data, id, ok: true },
          transferablesForViewport3DRegionOverlayBuildResult(data),
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
  installViewport3DRegionOverlayBuildWorker(
    globalThis as unknown as Viewport3DRegionOverlayBuildWorkerScope,
  );
}
