import type { Selection } from "@/kernel/selection/selectionTypes";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";

import type { RegionOverlaySelection } from "./layers/RegionOverlayLayer";
import type { Viewport3DPrimitiveObject } from "./viewport3dPrimitiveModel";

type ViewportSelectionPatch = Omit<Selection, "moduleSource">;

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
