import {
  collectSliceTopology,
  sampleSliceField,
} from "./femSliceGeometry";
import {
  visibilityPayloadToState,
  type FemSliceSamplingRequest,
  type FemSliceSamplingResponse,
} from "./femSliceSamplingTransport";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<FemSliceSamplingRequest>) => void) | null;
  postMessage: (message: FemSliceSamplingResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<FemSliceSamplingRequest>) => {
  const message = event.data;
  if (!message || message.type !== "compute") {
    return;
  }
  try {
    const { meshData, plane, planeCoord, component, visibilityState, boundsStrategy } = message.payload;
    const resolvedVisibilityState = visibilityPayloadToState(visibilityState);
    const topologyStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const topology = collectSliceTopology(
      meshData,
      plane,
      planeCoord,
      resolvedVisibilityState,
      boundsStrategy,
    );
    const fieldStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const slice = sampleSliceField(meshData, plane, component, topology);
    const done = typeof performance !== "undefined" ? performance.now() : Date.now();
    workerScope.postMessage({
      id: message.id,
      ok: true,
      topology,
      slice,
      topologyDurationMs: fieldStart - topologyStart,
      fieldDurationMs: done - fieldStart,
    });
  } catch (error) {
    workerScope.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : "slice worker failure",
    });
  }
};

export {};
