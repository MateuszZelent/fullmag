import type { BuilderSelectionTarget } from "@/features/geometry-builder/model/types";

export function isBuilderSelectionNodeId(nodeId: string | null | undefined): boolean {
  return Boolean(
    nodeId &&
      (nodeId === "builder-universe" ||
        nodeId.startsWith("builder-prim-") ||
        nodeId.startsWith("builder-bool-")),
  );
}

export function resolveBuilderSidebarNodeId(
  selection: BuilderSelectionTarget,
): string | null {
  switch (selection.type) {
    case "primitive":
      return `builder-prim-${selection.id}`;
    case "universe":
      return "builder-universe";
    case "boolean":
      return `builder-bool-${selection.id}`;
    default:
      return null;
  }
}

export function resolveBuilderSidebarSelectionSync(args: {
  builderEnabled: boolean;
  builderSelection: BuilderSelectionTarget;
  currentSidebarNodeId: string | null | undefined;
}): string | null {
  if (!args.builderEnabled) {
    return null;
  }
  const activeNodeId = resolveBuilderSidebarNodeId(args.builderSelection);
  if (activeNodeId) {
    return activeNodeId;
  }
  if (isBuilderSelectionNodeId(args.currentSidebarNodeId)) {
    return "builder-root";
  }
  return null;
}
