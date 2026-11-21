import type { InspectorPanelProps } from "../../inspectorTypes";
import type { Selection, SelectionRef } from "@/kernel/selection/selectionTypes";

type ModeVisualizationSelectionRef = Extract<
  SelectionRef,
  { type: "mode-visualization" }
>;

function modeVisualizationSelectionRef(
  selection: InspectorPanelProps["selection"],
): ModeVisualizationSelectionRef | null {
  return selection.ref?.type === "mode-visualization" ? selection.ref : null;
}

interface ModeVisualizationBreadcrumb {
  current: boolean;
  id: string;
  label: string;
  selection: Partial<Omit<Selection, "moduleSource">>;
}

const MODE_VISUALIZATION_NODE_MARKER = ":mode-visualization";

function objectLabel(objectId: string): string {
  return decodeURIComponent(objectId)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function modeRootNodeId(nodeId: string, objectId: string): string {
  const markerIndex = nodeId.indexOf(MODE_VISUALIZATION_NODE_MARKER);
  return markerIndex >= 0
    ? nodeId.slice(0, markerIndex + MODE_VISUALIZATION_NODE_MARKER.length)
    : `model:object:${objectId}:visualization${MODE_VISUALIZATION_NODE_MARKER}`;
}

export function buildModeVisualizationBreadcrumbs(
  selection: InspectorPanelProps["selection"],
): ModeVisualizationBreadcrumb[] {
  const target = modeVisualizationSelectionRef(selection);
  if (!target) return [];
  const rootNodeId = modeRootNodeId(target.nodeId, target.objectId);
  return [
    {
      current: false,
      id: `${target.objectId}:object`,
      label: objectLabel(target.objectId),
      selection: {
        kind: "object.root",
        label: objectLabel(target.objectId),
        nodeId: `model:object:${target.objectId}`,
        objectId: target.objectId,
        ref: {
          kind: "object.root",
          nodeId: `model:object:${target.objectId}`,
          objectId: target.objectId,
          type: "scene-object",
          visualizationTargetId: `object:${target.objectId}`,
        },
      },
    },
    {
      current: true,
      id: rootNodeId,
      label: "Mode visualization",
      selection: {
        kind: "object.mode_visualization",
        label: "Mode visualization",
        nodeId: rootNodeId,
        objectId: target.objectId,
        ref: target,
      },
    },
  ];
}
