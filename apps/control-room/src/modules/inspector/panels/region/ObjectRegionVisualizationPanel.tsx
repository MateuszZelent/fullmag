"use client";

import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { ObjectVisualizationPanel } from "../ObjectVisualizationPanel";
import type { RegionSubPanelProps } from "./shared";

export function ObjectRegionVisualizationPanel({ model }: RegionSubPanelProps) {
  const nodeId = `model:object:${model.objectId}:regions:${model.regionId}:visualization`;
  const selection: Selection = {
    kind: "object.region.visualization",
    label: model.regionName,
    moduleSource: "inspector",
    nodeId,
    objectId: model.objectId,
    ref: {
      kind: "object.region.visualization",
      nodeId,
      objectId: model.objectId,
      regionId: model.regionId,
      type: "scene-object",
      visualizationTargetId: visualizationTargetIdForSceneObject(
        model.objectId,
        model.regionId,
      ),
    },
  };

  return <ObjectVisualizationPanel selection={selection} />;
}
