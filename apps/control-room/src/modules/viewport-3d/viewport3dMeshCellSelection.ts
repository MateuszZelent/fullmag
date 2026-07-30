import type { MeshElementFamily } from "@/kernel/selection/selectionTypes";

import {
  selectionForMeshPart,
  type Viewport3DPartSelection,
} from "./viewport3dDomainAdapter";
import type {
  Viewport3DTopologyPartRenderModel,
} from "./viewport3dRenderModel";
import { resolveMeshPartSurfacePickIdentity } from "./layers/MeshPartLayer";
import {
  isViewport3DTopologyCurrent,
  type Viewport3DTopologyFreshness,
} from "./viewport3dTopologyStaleness";

export type Viewport3DMeshCellCarrier = "airbox" | "magnetic";

export interface Viewport3DMeshCellSelectionRequest {
  carrier: Viewport3DMeshCellCarrier;
  elementFamily: MeshElementFamily;
  globalCellOrdinal: string;
}

export interface Viewport3DMeshCellSelectionIdentity
  extends Viewport3DMeshCellSelectionRequest {
  carrierPartId: string;
}

type TopologyPart = Pick<
  Viewport3DTopologyPartRenderModel<Parameters<typeof selectionForMeshPart>[0]>,
  | "part"
  | "surfaceTriangleCellTypes"
  | "surfaceTriangleFacetIndices"
  | "surfaceTriangleGlobalCellOrdinals"
>;

interface Viewport3DMeshCellTopology {
  airboxParts: readonly TopologyPart[];
  magneticParts: readonly TopologyPart[];
}

export function currentViewport3DMeshCellAuditTopology<T>(
  topology: T | null,
  freshness: Viewport3DTopologyFreshness,
): T | null {
  return topology && isViewport3DTopologyCurrent(freshness) ? topology : null;
}

export function listViewport3DMeshCellSelections(
  topology: Viewport3DMeshCellTopology,
): Viewport3DMeshCellSelectionIdentity[] {
  return [
    ...listCarrierSelections("airbox", topology.airboxParts),
    ...listCarrierSelections("magnetic", topology.magneticParts),
  ];
}

export function resolveViewport3DMeshCellSelection(
  topology: Viewport3DMeshCellTopology,
  request: Viewport3DMeshCellSelectionRequest,
): Viewport3DPartSelection | null {
  const parts = request.carrier === "airbox"
    ? topology.airboxParts
    : topology.magneticParts;
  for (const partModel of parts) {
    const identities = listPartSelections(request.carrier, partModel);
    const identity = identities.find(
      (candidate) =>
        candidate.elementFamily === request.elementFamily &&
        candidate.globalCellOrdinal === request.globalCellOrdinal,
    );
    if (!identity) continue;
    const triangleIndex = findSurfaceTriangleIndex(partModel, identity);
    if (triangleIndex === null) continue;
    const pick = resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: triangleIndex,
      part: partModel.part,
      surfaceHit: true,
      surfaceTriangleCellTypes: partModel.surfaceTriangleCellTypes,
      surfaceTriangleFacetIndices: partModel.surfaceTriangleFacetIndices,
      surfaceTriangleGlobalCellOrdinals: partModel.surfaceTriangleGlobalCellOrdinals,
    });
    if (
      pick.elementFamily !== request.elementFamily ||
      pick.globalCellOrdinal !== request.globalCellOrdinal
    ) {
      continue;
    }
    return selectionForMeshPart(
      partModel.part,
      pick.boundaryFaceIndex,
      pick.globalCellOrdinal,
      pick.elementFamily,
    );
  }
  return null;
}

function listCarrierSelections(
  carrier: Viewport3DMeshCellCarrier,
  parts: readonly TopologyPart[],
): Viewport3DMeshCellSelectionIdentity[] {
  return parts.flatMap((partModel) => listPartSelections(carrier, partModel));
}

function listPartSelections(
  carrier: Viewport3DMeshCellCarrier,
  partModel: TopologyPart,
): Viewport3DMeshCellSelectionIdentity[] {
  const count = partModel.surfaceTriangleFacetIndices?.length ?? 0;
  const identities: Viewport3DMeshCellSelectionIdentity[] = [];
  const seen = new Set<string>();
  for (let triangleIndex = 0; triangleIndex < count; triangleIndex += 1) {
    const pick = resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: triangleIndex,
      part: partModel.part,
      surfaceHit: true,
      surfaceTriangleCellTypes: partModel.surfaceTriangleCellTypes,
      surfaceTriangleFacetIndices: partModel.surfaceTriangleFacetIndices,
      surfaceTriangleGlobalCellOrdinals: partModel.surfaceTriangleGlobalCellOrdinals,
    });
    if (!pick.elementFamily || !pick.globalCellOrdinal) continue;
    const key = `${pick.elementFamily}:${pick.globalCellOrdinal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push({
      carrier,
      carrierPartId: partModel.part.id,
      elementFamily: pick.elementFamily,
      globalCellOrdinal: pick.globalCellOrdinal,
    });
  }
  return identities;
}

function findSurfaceTriangleIndex(
  partModel: TopologyPart,
  identity: Viewport3DMeshCellSelectionIdentity,
): number | null {
  const count = partModel.surfaceTriangleFacetIndices?.length ?? 0;
  for (let triangleIndex = 0; triangleIndex < count; triangleIndex += 1) {
    const pick = resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: triangleIndex,
      part: partModel.part,
      surfaceHit: true,
      surfaceTriangleCellTypes: partModel.surfaceTriangleCellTypes,
      surfaceTriangleFacetIndices: partModel.surfaceTriangleFacetIndices,
      surfaceTriangleGlobalCellOrdinals: partModel.surfaceTriangleGlobalCellOrdinals,
    });
    if (
      pick.elementFamily === identity.elementFamily &&
      pick.globalCellOrdinal === identity.globalCellOrdinal
    ) {
      return triangleIndex;
    }
  }
  return null;
}
