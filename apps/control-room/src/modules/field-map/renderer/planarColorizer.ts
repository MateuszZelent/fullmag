import type {
  PlanarColorizeRequest,
  PlanarColorizeResponse,
} from "./planarRendererProtocol";

interface WorkerLike {
  onmessage: ((event: MessageEvent<PlanarColorizeResponse>) => void) | null;
  postMessage(message: PlanarColorizeRequest, transfer: Transferable[]): void;
  terminate(): void;
}

/** Keep the occupancy mask available for hover/probe while a worker owns a copy. */
export function clonePlanarMaskForWorker(
  mask: Uint8Array | null | undefined,
): Uint8Array | undefined {
  return mask ? new Uint8Array(mask) : undefined;
}

export function createPlanarColorizer(
  worker: WorkerLike,
  onPixels: (pixels: Uint8ClampedArray) => void,
) {
  let nextId = 0;
  let latestId = 0;
  worker.onmessage = (event) => {
    if (event.data.id !== latestId) return;
    onPixels(event.data.pixels);
  };
  return {
    colorize(
      values: Float32Array | Float64Array,
      range: { max: number; min: number },
      mask?: Uint8Array,
    ) {
      latestId = ++nextId;
      const workerMask = clonePlanarMaskForWorker(mask);
      const request: PlanarColorizeRequest = {
        id: latestId,
        kind: "colorize",
        mask: workerMask,
        range,
        values,
      };
      const transfers: Transferable[] = [values.buffer];
      if (workerMask) transfers.push(workerMask.buffer);
      worker.postMessage(request, transfers);
    },
    dispose() {
      worker.onmessage = null;
      worker.terminate();
    },
  };
}
