import {
  collectSliceTopology,
  sampleSliceField,
  type SliceBoundsStrategy,
  type SliceCollection,
  type SlicePlane,
  type SliceTopologyCollection,
  type VectorComponent,
} from "./femSliceGeometry";
import type { FemMeshData } from "./femMeshTypes";
import type { SliceVisibilityState } from "./femSliceUtils";

interface ComputeSliceSamplingPayload {
  meshData: FemMeshData;
  plane: SlicePlane;
  planeCoord: number;
  component: VectorComponent;
  visibilityState: SliceVisibilityState;
  boundsStrategy: SliceBoundsStrategy;
}

interface ComputeSliceSamplingRequest {
  id: number;
  type: "compute";
  payload: ComputeSliceSamplingPayload;
}

interface ComputeSliceSamplingSuccess {
  id: number;
  ok: true;
  topology: SliceTopologyCollection;
  slice: SliceCollection;
  topologyDurationMs: number;
  fieldDurationMs: number;
}

interface ComputeSliceSamplingFailure {
  id: number;
  ok: false;
  error: string;
}

type ComputeSliceSamplingResponse =
  | ComputeSliceSamplingSuccess
  | ComputeSliceSamplingFailure;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ComputeSliceSamplingRequest>) => void) | null;
  postMessage: (message: ComputeSliceSamplingResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<ComputeSliceSamplingRequest>) => {
  const message = event.data;
  if (!message || message.type !== "compute") {
    return;
  }
  try {
    const { meshData, plane, planeCoord, component, visibilityState, boundsStrategy } = message.payload;
    const topologyStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const topology = collectSliceTopology(
      meshData,
      plane,
      planeCoord,
      visibilityState,
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
