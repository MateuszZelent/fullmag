import { findResultNode, type ResultNodeKind, type ResultsWorkspaceState } from "./resultsWorkspace";

export function resultNodeKindToTreePrefix(kind: ResultNodeKind): string {
  switch (kind) {
    case "solution":
      return "res-solution-";
    case "dataset":
      return "res-dataset-";
    case "derived_value":
      return "res-derived-value-";
    case "plot_group":
      return "res-plot-group-";
    case "table":
      return "res-table-";
    case "analysis":
      return "res-analysis-";
    case "export":
      return "res-export-";
    case "report":
      return "res-report-";
  }
}

export function resultNodeToTreeNodeId(kind: ResultNodeKind, nodeId: string): string {
  return `${resultNodeKindToTreePrefix(kind)}${nodeId}`;
}

export function activeDatasetIdForResultNode(
  workspace: ResultsWorkspaceState,
  nodeId: string | null,
): string | null {
  if (!nodeId) {
    return workspace.datasets[0]?.id ?? null;
  }
  const node = findResultNode(workspace, nodeId);
  if (!node) {
    return workspace.datasets[0]?.id ?? null;
  }
  switch (node.nodeKind) {
    case "dataset":
      return node.id;
    case "derived_value":
      return node.sourceDatasetId;
    case "plot_group":
      return node.sourceDatasetId;
    case "table":
      return node.sourceDatasetId;
    default:
      return workspace.datasets[0]?.id ?? null;
  }
}
