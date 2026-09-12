import {
  computeProjectionSlice,
  type ProjectionOptions,
  type SlicePlane,
  type VectorComponent,
} from "./femSliceGeometry";
import type { SliceBoundsStrategy } from "./femSliceGeometry";
import type { SliceVisibilityState } from "./femSliceUtils";
import type { FemMeshData } from "./femMeshTypes";

interface ProjectionWorkerRequest {
  id: number;
  meshData: FemMeshData;
  plane: SlicePlane;
  component: VectorComponent;
  visibility: SliceVisibilityState | null;
  boundsStrategy: SliceBoundsStrategy;
  options: ProjectionOptions;
}

self.onmessage = (event: MessageEvent<ProjectionWorkerRequest>) => {
  const request = event.data;
  try {
    const result = computeProjectionSlice(
      request.meshData,
      request.plane,
      request.component,
      request.visibility,
      request.boundsStrategy,
      request.options,
    );
    self.postMessage({ id: request.id, result });
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "Projection worker failed",
    });
  }
};

export {};
