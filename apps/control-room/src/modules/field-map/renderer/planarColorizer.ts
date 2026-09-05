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

export function clonePlanarValuesForWorker(
  values: Float32Array | Float64Array,
): Float32Array | Float64Array {
  return values instanceof Float64Array ? new Float64Array(values) : new Float32Array(values);
}

export function createPlanarColorizer(
  worker: WorkerLike,
  onResult: (result: PlanarColorizeResponse) => void,
) {
  let nextId = 0;
  let latestId = 0;
  worker.onmessage = (event) => {
    if (event.data.id !== latestId) return;
    onResult(event.data);
  };
  return {
    colorize(
      values: Float32Array | Float64Array,
      range: { max: number; min: number },
      mask: Uint8Array | undefined,
      options: {
        colormap: string;
        contours: boolean;
        height: number;
        level?: number;
        levels?: readonly number[];
        opacity: number;
        width: number;
      },
    ) {
      latestId = ++nextId;
      const workerMask = clonePlanarMaskForWorker(mask);
      const workerValues = clonePlanarValuesForWorker(values);
      const request: PlanarColorizeRequest = {
        colormap: options.colormap,
        contours: { enabled: options.contours, level: options.level, levels: options.levels },
        height: options.height,
        id: latestId,
        kind: "colorize",
        mask: workerMask,
        opacity: options.opacity,
        range,
        values: workerValues,
        width: options.width,
      };
      const transfers: Transferable[] = [workerValues.buffer];
      if (workerMask) transfers.push(workerMask.buffer);
      worker.postMessage(request, transfers);
    },
    invalidate() {
      latestId = ++nextId;
    },
    dispose() {
      worker.onmessage = null;
      worker.terminate();
    },
  };
}
