import type { KernelApi, ModuleId } from "@/kernel/types";

import type { ExplorerNode } from "./explorerTypes";

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
    },
    source,
  );
}
