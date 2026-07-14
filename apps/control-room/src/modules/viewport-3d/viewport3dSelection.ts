import type { Selection } from "@/kernel/selection/selectionTypes";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import type { SemanticRenderTargetAddress } from "@/kernel/selection/semanticRenderTargetCatalog";

import type { RegionOverlaySelection } from "./layers/RegionOverlayLayer";
import type { Viewport3DPrimitiveObject } from "./viewport3dPrimitiveModel";

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
    label: string;
  },
): ViewportSelectionPatch {
  if (address.targetKind === "airbox") {
    return {
      kind: "airbox.root",
      label: hit.label,
      nodeId: address.explorerNodeId,
      objectId: null,
      ref: {
        boundaryFaceIndex: hit.boundaryFaceIndex,
        carrierPartId: hit.carrierPartId,
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
      kind: "mesh-part",
      nodeId: address.explorerNodeId,
      objectId: null,
      type: "mesh-part",
      visualizationTargetId: address.targetId,
    },
  };
}
