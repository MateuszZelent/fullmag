import type { SavedFieldGeometryResource } from "@/kernel/api/apiTypes";
import type { DecodedTopology } from "@/kernel/api/codecs";

import {
  buildViewport3DTopologyRenderModel,
  resolveTopologyBounds,
  type Viewport3DBounds,
} from "../viewport3dRenderModel";

export interface SavedAntennaSourceModel {
  bounds: Viewport3DBounds | null;
  key: string;
  positions: Float32Array;
  triangles: Uint32Array;
}

/** Display-only archived conductor; it never owns a field or magnetic object. */
export function buildSavedAntennaSourceModel(
  geometry: SavedFieldGeometryResource,
  topology: DecodedTopology,
): SavedAntennaSourceModel | null {
  if (geometry.node_count !== String(topology.nodeCount) ||
      topology.positions.length !== topology.nodeCount * 3) return null;
  const model = buildViewport3DTopologyRenderModel(topology, [], [], new Map(), {
    meshGenerationId: `saved-source:${geometry.geometry_manifest.object_ref}`,
    meshRevision: geometry.geometry_manifest.object_ref,
    meshTopologyHash: geometry.topology_fingerprint,
  });
  if (!model || !model.fallbackSurfaceIndices.length) return null;
  return {
    bounds: resolveTopologyBounds(topology),
    key: geometry.geometry_manifest.object_ref,
    positions: model.positions,
    triangles: model.fallbackSurfaceIndices,
  };
}
