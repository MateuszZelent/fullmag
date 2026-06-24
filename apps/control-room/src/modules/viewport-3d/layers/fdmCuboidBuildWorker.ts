import {
  buildViewport3DFdmCuboid,
  transferablesForFdmCuboidBuildResult,
  type FdmCuboidBuildRequest,
  type FdmCuboidBuildResult,
} from "./fdmCuboidBuildModel";

export interface FdmCuboidBuildWorkerRequest extends FdmCuboidBuildRequest {
  id: number;
}

export interface FdmCuboidBuildWorkerOkResponse {
  data: FdmCuboidBuildResult;
  id: number;
  ok: true;
}

export interface FdmCuboidBuildWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

export type FdmCuboidBuildWorkerResponse =
  | FdmCuboidBuildWorkerErrorResponse
  | FdmCuboidBuildWorkerOkResponse;

interface FdmCuboidBuildWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<FdmCuboidBuildWorkerRequest>) => void,
  ): void;
  postMessage(
    message: FdmCuboidBuildWorkerResponse,
    transfer?: Transferable[],
  ): void;
}

export function installFdmCuboidBuildWorker(
  workerScope: FdmCuboidBuildWorkerScope,
): void {
  workerScope.addEventListener(
    "message",
    (event: MessageEvent<FdmCuboidBuildWorkerRequest>) => {
      const { id, ...request } = event.data;
      try {
        const data = buildViewport3DFdmCuboid(request);
        workerScope.postMessage(
          { data, id, ok: true },
          transferablesForFdmCuboidBuildResult(data),
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
  installFdmCuboidBuildWorker(
    globalThis as unknown as FdmCuboidBuildWorkerScope,
  );
}
