import type { DecodedTopology } from "@/kernel/api/codecs";
import {
  buildRegionMeshOverlayModels,
  type RegionMeshOverlayModel,
  type RegionMeshOverlayOwnerPart,
  type RegionOverlayInput,
  type RegionOverlayTheme,
} from "../layers/regionOverlayModel";

export interface Viewport3DRegionOverlayBuildRequest {
  magneticParts: readonly RegionMeshOverlayOwnerPart[];
  regions: readonly RegionOverlayInput[];
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  theme?: RegionOverlayTheme;
  topology: DecodedTopology;
}

export interface Viewport3DRegionOverlayBuildResult {
  models: RegionMeshOverlayModel[];
}

export interface Viewport3DRegionOverlayBuildByteEstimateInput {
  magneticParts: readonly RegionMeshOverlayOwnerPart[];
  regions: readonly RegionOverlayInput[];
  topology: Pick<DecodedTopology, "indices" | "positions">;
}

export function buildViewport3DRegionOverlayModels({
  magneticParts,
  regions,
  selectedObjectId,
  selectedRegionId,
  theme,
  topology,
}: Viewport3DRegionOverlayBuildRequest): Viewport3DRegionOverlayBuildResult {
  return {
    models: buildRegionMeshOverlayModels(regions, topology, magneticParts, {
      selectedObjectId,
      selectedRegionId,
      theme,
    }),
  };
}

export function estimateViewport3DRegionOverlayBuildInputBytes({
  topology,
}: Viewport3DRegionOverlayBuildByteEstimateInput): number {
  return topology.indices.byteLength + topology.positions.byteLength;
}

export function estimateViewport3DRegionOverlayBuildOutputBytes({
  models,
}: Viewport3DRegionOverlayBuildResult): number {
  return models.reduce(
    (total, model) =>
      total +
      model.positions.byteLength +
      (model.edgeIndices?.byteLength ?? 0) +
      (model.surfaceEdgeIndices?.byteLength ?? 0) +
      (model.surfaceIndices?.byteLength ?? 0),
    0,
  );
}

export function transferablesForViewport3DRegionOverlayBuildResult({
  models,
}: Viewport3DRegionOverlayBuildResult): Transferable[] {
  const transferables: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const model of models) {
    addArrayBufferTransferable(transferables, seen, model.positions.buffer);
    addArrayBufferTransferable(transferables, seen, model.edgeIndices?.buffer);
    addArrayBufferTransferable(
      transferables,
      seen,
      model.surfaceEdgeIndices?.buffer,
    );
    addArrayBufferTransferable(transferables, seen, model.surfaceIndices?.buffer);
  }
  return transferables;
}

function addArrayBufferTransferable(
  transferables: Transferable[],
  seen: Set<ArrayBuffer>,
  buffer: ArrayBufferLike | undefined,
): void {
  if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) return;
  seen.add(buffer);
  transferables.push(buffer);
}
