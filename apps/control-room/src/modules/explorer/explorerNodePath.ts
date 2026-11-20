import { publishSelectionPath } from "@/kernel/selection/selectionPath";

import { selectionFromExplorerNode } from "./explorerSelection";
import type { ExplorerNode } from "./explorerTypes";

/** Root-first chain of nodes ending at `nodeId`, or null when it is not in the tree. */
export function findExplorerNodePath(
  nodes: readonly ExplorerNode[],
  nodeId: string,
): ExplorerNode[] | null {
  for (const node of nodes) {
    if (node.id === nodeId) return [node];
    if (node.children?.length) {
      const below = findExplorerNodePath(node.children, nodeId);
      if (below) return [node, ...below];
    }
  }
  return null;
}

/**
 * Publishes the selected node's tree path through the kernel, which the
 * Inspector shows as its full selection path. Ancestors carry the selection
 * they restore; the selected node itself carries none.
 */
export function publishExplorerNodePath(
  nodes: readonly ExplorerNode[],
  nodeId: string | null,
): void {
  const path = nodeId ? findExplorerNodePath(nodes, nodeId) : null;
  publishSelectionPath(path && nodeId ? {
    nodeId,
    crumbs: path.map((node, index) => ({
      id: node.id,
      label: node.label,
      selection: index < path.length - 1 && node.selectable !== false
        ? selectionFromExplorerNode(node)
        : undefined,
    })),
  } : null);
}
