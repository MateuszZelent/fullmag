import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs";
import type {
  MeshElementFamily,
  Selection,
} from "@/kernel/selection/selectionTypes";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import type { SemanticRenderTargetAddress } from "@/kernel/selection/semanticRenderTargetCatalog";

import type { RegionOverlaySelection } from "./layers/RegionOverlayLayer";
import type { Viewport3DPrimitiveObject } from "./viewport3dPrimitiveModel";
import type { FdmCuboidInstanceModel } from "./layers/FdmCuboidLayer";
import { resolveFdmCellState } from "@/shared/domain/mesh/domainPresentation";

type ViewportSelectionPatch = Omit<Selection, "moduleSource">;

export function viewportSelectionForDomain(
  domainId: string | null | undefined,
): ViewportSelectionPatch {
  return {
    kind: "universe.root",
    label: domainId ?? "Domain",
    nodeId: "model:universe",
    objectId: null,
    ref: null,
  };
}

/** Build an FDM cell selection only from a canonical membership identity. */
export function viewportSelectionForFdmCell({
  instanceId,
  model,
  domainShape,
  membership,
  binary,
}: {
  instanceId: number;
  model: FdmCuboidInstanceModel | null | undefined;
  domainShape: readonly [number, number, number] | null | undefined;
  membership: FdmRegionMembershipResource | null | undefined;
  binary: DecodedFdmRegionMembership | null | undefined;
}): ViewportSelectionPatch | null {
  if (!model || !Number.isInteger(instanceId) || instanceId < 0) return null;
  if (!membership || !binary || binary.semanticStatus !== "canonical") return null;
  if (
    membership.freshness.toLowerCase() !== "current" ||
    !membership.grid_fingerprint ||
    binary.gridFingerprint !== membership.grid_fingerprint
  ) return null;
  if (!domainShape || domainShape.length < 3) return null;
  if (domainShape.some((value) => !Number.isInteger(value) || value <= 0)) return null;
  const cellOrdinal = model.cellIndices[instanceId];
  if (cellOrdinal === undefined || cellOrdinal >= binary.cellCount) return null;
  if (
    binary.counts[0] !== domainShape[0] ||
    binary.counts[1] !== domainShape[1] ||
    binary.counts[2] !== domainShape[2]
  ) return null;
  const nx = domainShape[0];
  const ny = domainShape[1];
  const ix = cellOrdinal % nx;
  const iy = Math.floor(cellOrdinal / nx) % ny;
  const iz = Math.floor(cellOrdinal / (nx * ny));
  const numericRegionId = binary.regionIds[cellOrdinal];
  if (numericRegionId === undefined) return null;
  const state = resolveFdmCellState(numericRegionId, membership);
  return {
    kind: "fdm.cell",
    label: `Cell ${cellOrdinal}`,
    nodeId: "model:mesh:grid",
    objectId: null,
    ref: {
      cellOrdinal: String(cellOrdinal),
      gridFingerprint: membership.grid_fingerprint,
      ijk: [ix, iy, iz],
      kind: "fdm.cell",
      maskState: state.kind,
      membershipRevision: `${membership.mesh_revision}:${membership.region_membership_revision}`,
      nodeId: "model:mesh:grid",
      numericRegionId: state.numericRegionId,
      regionId: state.regionId,
      type: "fdm-cell",
      visualizationTargetId: "fdm-domain",
    },
  };
}

export function viewportSelectionForObject(
  object: Pick<Viewport3DPrimitiveObject, "label" | "objectId">,
): ViewportSelectionPatch {
  const nodeId = `model:object:${object.objectId}`;
  return {
    kind: "object.root",
    label: object.label,
    nodeId,
    objectId: object.objectId,
    ref: {
      kind: "object.root",
      nodeId,
      objectId: object.objectId,
      type: "scene-object",
      visualizationTargetId: visualizationTargetIdForSceneObject(object.objectId),
    },
  };
}

export function viewportSelectionForRegion(
  region: RegionOverlaySelection,
): ViewportSelectionPatch {
  const nodeId = `model:object:${region.objectId}:regions:${region.regionId}`;
  return {
    kind: "object.region",
    label: region.regionId,
    nodeId,
    objectId: region.objectId,
    ref: {
      kind: "object.region",
      nodeId,
      objectId: region.objectId,
      regionId: region.regionId,
      type: "scene-object",
      visualizationTargetId: visualizationTargetIdForSceneObject(
        region.objectId,
        region.regionId,
      ),
    },
  };
}

export function viewportSelectionForMeshPart(
  address: SemanticRenderTargetAddress,
  hit: {
    boundaryFaceIndex?: number | null;
    carrierPartId: string;
    elementFamily?: MeshElementFamily | null;
    globalCellOrdinal?: string | null;
    label: string;
  },
): ViewportSelectionPatch {
  if (address.targetKind === "airbox") {
    return {
      kind: "airbox.root",
      label: address.label,
      nodeId: address.explorerNodeId,
      objectId: null,
      ref: {
        boundaryFaceIndex: hit.boundaryFaceIndex,
        carrierPartId: hit.carrierPartId,
        elementFamily: hit.elementFamily,
        globalCellOrdinal: hit.globalCellOrdinal,
        kind: "airbox.root",
        nodeId: address.explorerNodeId,
        type: "airbox",
        visualizationTargetId: "airbox",
      },
    };
  }

  if (address.targetKind === "object") {
    const objectId = address.targetId.slice("object:".length);
    return {
      kind: "object.root",
      label: hit.label,
      nodeId: address.explorerNodeId,
      objectId,
      ref: {
        boundaryFaceIndex: hit.boundaryFaceIndex,
        carrierPartId: hit.carrierPartId,
        elementFamily: hit.elementFamily,
        globalCellOrdinal: hit.globalCellOrdinal,
        kind: "object.root",
        nodeId: address.explorerNodeId,
        objectId,
        type: "scene-object",
        visualizationTargetId: `object:${objectId}`,
      },
    };
  }

  return {
    kind: "mesh-part",
    label: hit.label,
    nodeId: address.explorerNodeId,
    objectId: null,
    ref: {
      boundaryFaceIndex: hit.boundaryFaceIndex,
      carrierPartId: hit.carrierPartId,
      elementFamily: hit.elementFamily,
      globalCellOrdinal: hit.globalCellOrdinal,
      kind: "mesh-part",
      nodeId: address.explorerNodeId,
      objectId: null,
      type: "mesh-part",
      visualizationTargetId: address.targetId,
    },
  };
}
