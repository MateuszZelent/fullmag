import type { FdmCuboidBuildResult } from "../layers/fdmCuboidBuildModel";

export interface FdmVectorOnlyRenderBuffers {
  readonly vectorCellIndices: Uint32Array | null;
  readonly vectorSegments: Float32Array | null;
  readonly vectorsVisible: boolean;
}

/**
 * Resolve the vector pass independently from the optional cuboid cell model.
 * Callers provide field availability only after their existing scope/domain
 * compatibility checks have passed.
 */
export function resolveFdmVectorOnlyRenderBuffers({
  buildResult,
  fieldAvailable,
  layerVisible,
  vectorsEnabled,
}: {
  buildResult: FdmCuboidBuildResult | null | undefined;
  fieldAvailable: boolean;
  layerVisible: boolean;
  vectorsEnabled: boolean;
}): FdmVectorOnlyRenderBuffers {
  const vectorsVisible = fieldAvailable && layerVisible && vectorsEnabled;

  return {
    vectorCellIndices: vectorsVisible
      ? buildResult?.vectorCellIndices ?? null
      : null,
    vectorSegments: vectorsVisible
      ? buildResult?.vectorSegments ?? null
      : null,
    vectorsVisible,
  };
}
