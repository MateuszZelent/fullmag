import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi, ModuleId } from "@/kernel/types";

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

  return null;
}

export function selectExplorerNode(
  kernel: KernelApi,
  node: ExplorerNode,
  source: ModuleId,
): void {
  kernel.selection.set(
    {
      kind: node.kind,
      label: node.label,
      nodeId: node.id,
      objectId: node.objectId ?? null,
      ref: selectionRefFromNode(node),
    },
    source,
  );
}
