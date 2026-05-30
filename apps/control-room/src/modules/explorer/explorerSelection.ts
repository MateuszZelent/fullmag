import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi, ModuleId } from "@/kernel/types";
import { selectCrossSectionPlot } from "@/kernel/workspace/crossSectionWorkspace";

import type { ExplorerNode } from "./explorerTypes";

function selectionRefFromNode(node: ExplorerNode): SelectionRef | null {
  if (
    node.objectId &&
    (node.kind === "object.root" ||
      node.kind === "object.geometry" ||
      node.kind === "object.material" ||
      node.kind === "object.physics" ||
      node.kind === "object.regions" ||
      node.kind === "object.region-magnetic-texture" ||
      node.kind === "object.magnetic-parameters" ||
      node.kind === "object.magnetic-texture" ||
      node.kind === "object.mesh" ||
      node.kind === "object.visualization")
  ) {
    return {
      kind: node.kind,
      nodeId: node.id,
      objectId: node.objectId,
      ...(node.regionId ? { regionId: node.regionId } : {}),
      type: "scene-object",
      visualizationTargetId: `object:${node.objectId}`,
    };
  }

  if (node.kind === "airbox.mesh" || node.kind === "airbox.visualization") {
    return {
      kind: node.kind,
      nodeId: node.id,
      type: "airbox",
      visualizationTargetId: "airbox",
    };
  }

  if (
    node.kind === "visualizations-2d.draft" ||
    (node.kind === "visualizations-2d.parameter" && node.crossSectionDraftId)
  ) {
    return {
      draftId: node.crossSectionDraftId ?? "draft",
      kind: "mesh.cross-section.draft",
      nodeId: node.id,
      type: "cross-section-draft",
      visualizationTargetId: "cross-section:draft",
    };
  }

  if (
    (node.kind === "visualizations-2d.plot" ||
      node.kind === "visualizations-2d.parameter") &&
    node.crossSectionPlotId
  ) {
    return {
      kind: "mesh.cross-section.plot",
      nodeId: node.id,
      plotId: node.crossSectionPlotId,
      type: "cross-section-plot",
      visualizationTargetId: `cross-section:plot:${node.crossSectionPlotId}`,
    };
  }

  if (
    node.stageId &&
    node.stageIndex !== undefined &&
    (node.kind === "study.stage.action" ||
      node.kind === "study.stage.eigenmodes" ||
      node.kind === "study.stage.relax" ||
      node.kind === "study.stage.run")
  ) {
    return {
      kind: node.kind,
      nodeId: node.id,
      stageId: node.stageId,
      stageIndex: node.stageIndex,
      type: "study-stage",
    };
  }

  return null;
}

export function selectExplorerNode(
  kernel: KernelApi,
  node: ExplorerNode,
  source: ModuleId,
): void {
  if (node.crossSectionPlotId) {
    selectCrossSectionPlot(node.crossSectionPlotId);
  }
  const ref = selectionRefFromNode(node);
  kernel.selection.set(
    {
      kind:
        ref?.type === "cross-section-draft" ||
        ref?.type === "cross-section-plot"
          ? ref.kind
          : node.kind,
      label: node.label,
      nodeId: node.id,
      objectId: node.objectId ?? null,
      ref,
    },
    source,
  );
}
