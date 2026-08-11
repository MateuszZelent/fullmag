"use client";

import { useKernel } from "@/kernel/KernelContext";
import {
  modeVisualizationTargetId,
  type Selection,
  type SelectionRef,
} from "@/kernel/selection/selectionTypes";

import type { InspectorPanelProps } from "../../inspectorTypes";

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

function modeRootRef(
  target: ModeVisualizationSelectionRef,
  nodeId: string,
): ModeVisualizationSelectionRef {
  const rootFieldId =
    target.modeVisualizationRootFieldId ?? target.fieldId;
  const rootSource =
    target.modeVisualizationRootSource ?? target.source;
  return {
    fieldId: rootFieldId,
    kind: "object.mode_visualization",
    modeVisualizationRootFieldId: rootFieldId,
    modeVisualizationRootSource: rootSource,
    nodeId,
    objectId: target.objectId,
    source: rootSource,
    type: "mode-visualization",
    view: undefined,
    visualizationTargetId: modeVisualizationTargetId(
      target.objectId,
      rootSource,
      rootFieldId,
    ),
  };
}

export function buildModeVisualizationBreadcrumbs(
  selection: InspectorPanelProps["selection"],
): ModeVisualizationBreadcrumb[] {
  const target = modeVisualizationSelectionRef(selection);
  if (!target) return [];
  const rootNodeId = modeRootNodeId(target.nodeId, target.objectId);
  const atRoot = target.kind === "object.mode_visualization";
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
      current: atRoot,
      id: rootNodeId,
      label: "Mode visualization",
      selection: {
        kind: "object.mode_visualization",
        label: "Mode visualization",
        nodeId: rootNodeId,
        objectId: target.objectId,
        ref: modeRootRef(target, rootNodeId),
      },
    },
    ...(atRoot
      ? []
      : [
          {
            current: true,
            id: target.nodeId,
            label: selection.label ?? "Selection",
            selection,
          },
        ]),
  ];
}

export function ModeVisualizationBreadcrumbs({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const breadcrumbs = buildModeVisualizationBreadcrumbs(selection);
  if (breadcrumbs.length === 0) return null;
  return (
    <nav
      aria-label="Mode visualization path"
      className="fm-inspector__breadcrumbs"
    >
      {breadcrumbs.map((breadcrumb, index) => (
        <span className="fm-inspector__breadcrumb-item" key={breadcrumb.id}>
          {index > 0 ? (
            <span aria-hidden="true" className="fm-inspector__breadcrumb-separator">
              /
            </span>
          ) : null}
          {breadcrumb.current ? (
            <span className="fm-inspector__breadcrumb">{breadcrumb.label}</span>
          ) : (
            <button
              className="fm-inspector__breadcrumb"
              type="button"
              onClick={() => kernel.selection.set(breadcrumb.selection, "inspector")}
            >
              {breadcrumb.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
