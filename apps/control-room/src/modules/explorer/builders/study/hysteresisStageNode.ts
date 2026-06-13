import type {
  ExplorerNode,
  ModelTreeStudyStageSnapshot,
} from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

type HysteresisExecutionTreeNode = NonNullable<
  ModelTreeStudyStageSnapshot["hysteresisExecutionTree"]
>["nodes"][number];

export function buildHysteresisStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  const node = buildStudyStageBaseNode({
    badge: stage.artifactName ?? "field sweep",
    icon: "activity",
    kind: "study.stage.hysteresis",
    label: `Hysteresis ${stage.index + 1}`,
    stage,
  });
  const nodeStageId = stage.stageId ?? `${stage.index}`;
  node.children = [
    ...(node.children ?? []),
    buildHysteresisPlanNode(stage, node.id, nodeStageId),
    buildHysteresisProtocolNode(stage, node.id, nodeStageId),
    buildHysteresisOrientationNode(stage, node.id, nodeStageId),
    buildHysteresisSaturationNode(stage, node.id, nodeStageId),
    buildHysteresisAdaptiveRefinementNode(stage, node.id, nodeStageId),
    buildHysteresisAngularFamilyNode(stage, node.id, nodeStageId),
    buildHysteresisSettlePipelineNode(stage, node.id, nodeStageId),
    buildHysteresisLiveRunNode(stage, node.id, nodeStageId),
    buildHysteresisBranchesNode(stage, node.id, nodeStageId),
    buildHysteresisPointsNode(stage, node.id, nodeStageId),
    buildHysteresisMetricsNode(stage, node.id, nodeStageId),
    buildHysteresisSnapshotsNode(stage, node.id, nodeStageId),
    buildHysteresisFieldNode(stage, node.id, nodeStageId),
    buildHysteresisTransitionsNode(stage, node.id, nodeStageId),
  ];
  return node;
}

function buildHysteresisPlanNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:plan`,
    kind: "study.stage.action",
    label: "Plan",
    parentId,
    badge: hysteresisPlanBadge(stage),
    icon: "settings",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stage.status === "completed" ? "completed" : "ready",
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisProtocolNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:protocol`,
    kind: "study.stage.action",
    label: "Protocol",
    parentId,
    badge: hysteresisProtocolBadge(stage),
    icon: "activity",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stage.status === "completed" ? "completed" : "ready",
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisOrientationNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:orientation`,
    kind: "study.stage.action",
    label: "Orientation",
    parentId,
    badge: "field axis",
    icon: "magnet",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisSaturationNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:saturation`,
    kind: "study.stage.action",
    label: "Saturation",
    parentId,
    badge: stage.hysteresisSaturationMode ?? "not configured",
    icon: "gauge",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stage.status === "completed"
      ? "completed"
      : stage.hysteresisSaturationMode
        ? "ready"
        : "skipped",
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisAdaptiveRefinementNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:adaptive-refinement`,
    kind: "study.stage.action",
    label: "Adaptive Refinement",
    parentId,
    badge: "runtime pass",
    icon: "gauge",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisAngularFamilyNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:angular-family`,
    kind: "study.stage.action",
    label: "Angular Family",
    parentId,
    badge: "variants",
    icon: "layers",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisSettlePipelineNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  const settleStepCount = stage.hysteresisSettleSteps?.length ?? 0;
  return {
    id: `${parentId}:settle-pipeline`,
    kind: "study.stage.action",
    label: "Settle Pipeline",
    parentId,
    badge:
      settleStepCount > 0
        ? `${settleStepCount} step${settleStepCount === 1 ? "" : "s"}`
        : "solver default",
    icon: "activity",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisLiveRunNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:live-run`,
    kind: "study.stage.action",
    label: "Live Run",
    parentId,
    badge: hysteresisFieldLabel(stage),
    icon: "play",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisBranchesNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  const branchesNodeId = `${parentId}:branches`;
  const runtimeBranchNodes = hysteresisExecutionTreeBranchNodes(stage);
  return {
    id: branchesNodeId,
    kind: "study.stage.action",
    label: "Branches",
    parentId,
    badge: stage.hysteresisBranchMode ?? "custom",
    icon: "layers",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
    children: runtimeBranchNodes.length > 0
      ? runtimeBranchNodes.map((node, index) =>
          buildHysteresisRuntimeBranchNode(
            node,
            index,
            branchesNodeId,
            nodeStageId,
            stage.index,
          ),
        )
      : [
          buildHysteresisBranchNode(
            stage,
            branchesNodeId,
            nodeStageId,
            "forward",
            "Forward",
            "ready",
          ),
          buildHysteresisBranchNode(
            stage,
            branchesNodeId,
            nodeStageId,
            "return",
            "Return",
            "queued",
          ),
          buildHysteresisBranchNode(
            stage,
            branchesNodeId,
            nodeStageId,
            "minor-loops",
            "Minor Loops",
            "queued",
          ),
        ],
  };
}

function buildHysteresisRuntimeBranchNode(
  node: HysteresisExecutionTreeNode,
  index: number,
  parentId: string,
  nodeStageId: string,
  stageIndex: number,
): ExplorerNode {
  const branchNodeId = `${parentId}:${hysteresisExecutionTreeBranchIdSuffix(node, index)}`;
  return {
    id: branchNodeId,
    kind: "study.stage.action",
    label: node.label,
    parentId,
    badge: "runtime branch",
    icon: "activity",
    branchId: node.node_id,
    hysteresisExecutionNodeId: node.node_id,
    hysteresisExecutionNodeKind: node.kind,
    ...(node.resource_ref ? { resourceRef: node.resource_ref } : {}),
    stageId: nodeStageId,
    stageIndex,
    status: explorerStatusFromExecutionTree(node.status),
    contextCommands: ["workspace.focus-selection"],
    children: node.children?.map((child, childIndex) =>
      buildHysteresisExecutionTreeChildNode(
        child,
        childIndex,
        branchNodeId,
        nodeStageId,
        stageIndex,
      ),
    ) ?? [],
  };
}

function buildHysteresisBranchNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
  idSuffix: string,
  label: string,
  fallbackStatus: ExplorerNode["status"],
): ExplorerNode {
  return {
    id: `${parentId}:${idSuffix}`,
    kind: "study.stage.action",
    label,
    parentId,
    badge: idSuffix === "minor-loops" ? "optional" : "planned",
    icon: "activity",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stage.status === "completed" ? "completed" : fallbackStatus,
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisMetricsNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:metrics`,
    kind: "study.stage.action",
    label: "Metrics",
    parentId,
    badge: stage.status === "completed" ? "ready" : "live",
    icon: "gauge",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisSnapshotsNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  return {
    id: `${parentId}:snapshots`,
    kind: "study.stage.action",
    label: "Snapshots",
    parentId,
    badge: "storage policy",
    icon: "database",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
  };
}

function buildHysteresisPointsNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  const plannedPointCount = hysteresisExecutionTreePointCount(stage)
    ?? hysteresisPlannedPointCount(stage);
  const currentPointIndex =
    typeof stage.hysteresisExecutionTree?.active_point_index === "number"
      ? Math.max(0, stage.hysteresisExecutionTree.active_point_index)
      : typeof stage.hysteresisCurrentPointIndex === "number"
      ? Math.max(0, stage.hysteresisCurrentPointIndex)
      : null;
  const currentOrdinal =
    currentPointIndex !== null
      ? Math.min(currentPointIndex + 1, plannedPointCount ?? currentPointIndex + 1)
      : null;
  const pointsNodeId = `${parentId}:points`;
  return {
    id: pointsNodeId,
    kind: "study.stage.action",
    label: "Points",
    parentId,
    badge: hysteresisPointsBadge(plannedPointCount, currentOrdinal),
    icon: "layers",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
    children: buildHysteresisPointSummaryNodes(
      stage,
      pointsNodeId,
      nodeStageId,
      plannedPointCount,
      currentPointIndex,
    ),
  };
}

function buildHysteresisTransitionsNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  const transitionsNodeId = `${parentId}:transitions`;
  const stageCompleted = stage.status === "completed";
  return {
    id: transitionsNodeId,
    kind: "study.stage.action",
    label: "Transitions",
    parentId,
    badge: stageCompleted ? "available" : "after completion",
    icon: "activity",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stageCompleted ? "ready" : "queued",
    contextCommands: ["workspace.focus-selection"],
    children: [
      {
        id: `${transitionsNodeId}:continue`,
        kind: "study.stage.action",
        label: "Continue to next stage",
        parentId: transitionsNodeId,
        badge: stageCompleted ? "available" : "pending",
        icon: "play",
        stageId: nodeStageId,
        stageIndex: stage.index,
        status: stageCompleted ? "ready" : "queued",
        contextCommands: ["workspace.focus-selection"],
      },
      {
        id: `${transitionsNodeId}:use-selected-point`,
        kind: "study.stage.action",
        label: "Use selected point as initial",
        parentId: transitionsNodeId,
        badge: "explicit action",
        icon: "magnet",
        stageId: nodeStageId,
        stageIndex: stage.index,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
      },
    ],
  };
}

function buildHysteresisFieldNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
  const executionFieldNode = activeExecutionTreeFieldNode(stage);
  if (executionFieldNode) {
    const fieldNodeId = `${parentId}:field-point:${executionFieldNode.point_id ?? 0}`;
    return {
      id: fieldNodeId,
      kind: "study.stage.action",
      label: executionFieldNode.label,
      parentId,
      badge: executionFieldNode.label,
      icon: "magnet",
      stageId: nodeStageId,
      stageIndex: stage.index,
      status: explorerStatusFromExecutionTree(executionFieldNode.status),
      contextCommands: ["workspace.focus-selection"],
      children: executionFieldNode.children?.map((child, index) =>
        buildHysteresisExecutionTreeChildNode(
          child,
          index,
          fieldNodeId,
          nodeStageId,
          stage.index,
        ),
      ) ?? [],
    };
  }

  const fieldLabel = hysteresisFieldLabel(stage);
  const fieldNodeId = `${parentId}:${hysteresisFieldNodeSuffix(stage)}`;
  return {
    id: fieldNodeId,
    kind: "study.stage.action",
    label: "Current Field",
    parentId,
    badge: fieldLabel,
    icon: "magnet",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisStageStatus(stage),
    contextCommands: ["workspace.focus-selection"],
    children: buildHysteresisAlgorithmNodes(stage, fieldNodeId, nodeStageId),
  };
}

function buildHysteresisExecutionTreeChildNode(
  node: HysteresisExecutionTreeNode,
  index: number,
  parentId: string,
  nodeStageId: string,
  stageIndex: number,
): ExplorerNode {
  const idSuffix = hysteresisExecutionTreeChildIdSuffix(node, index);
  const replayableSnapshotPointId =
    node.kind === "snapshot" && typeof node.point_id === "number"
      ? node.point_id
      : null;
  return {
    id: `${parentId}:${idSuffix}`,
    kind: "study.stage.action",
    label: node.label,
    parentId,
    badge: hysteresisExecutionTreeChildBadge(node),
    icon: hysteresisExecutionTreeChildIcon(node),
    hysteresisExecutionNodeId: node.node_id,
    hysteresisExecutionNodeKind: node.kind,
    ...(typeof node.point_id === "number"
      ? { hysteresisPointId: node.point_id }
      : {}),
    ...(node.resource_ref ? { resourceRef: node.resource_ref } : {}),
    ...(replayableSnapshotPointId !== null
      ? {
          hysteresisPointId: replayableSnapshotPointId,
          hysteresisSnapshotId: hysteresisSnapshotIdFromExecutionNode(node) ?? undefined,
          resourceRef: node.resource_ref ?? undefined,
        }
      : {}),
    stageId: nodeStageId,
    stageIndex,
    status: explorerStatusFromExecutionTree(node.status),
    contextCommands: ["workspace.focus-selection"],
  };
}

function hysteresisExecutionTreeChildIdSuffix(
  node: HysteresisExecutionTreeNode,
  index: number,
): string {
  if (node.kind === "settle_algorithm") {
    return `algorithm:${node.settle_step_id ?? index}`;
  }
  if (node.kind === "snapshot") {
    return `snapshot:${lastNodeIdSegment(node.node_id) ?? index}`;
  }
  if (node.kind === "warning") {
    return `warning:${sanitizeExplorerIdSegment(node.node_id) ?? index}`;
  }
  return `${sanitizeExplorerIdSegment(node.kind) ?? "node"}:${sanitizeExplorerIdSegment(node.node_id) ?? index}`;
}

function hysteresisExecutionTreeBranchIdSuffix(
  node: HysteresisExecutionTreeNode,
  index: number,
): string {
  return `branch:${lastNodeIdSegment(node.node_id) ?? index}`;
}

function hysteresisExecutionTreeChildBadge(
  node: HysteresisExecutionTreeNode,
): string {
  if (node.kind === "settle_algorithm") return node.settle_step_id ?? node.kind;
  if (node.kind === "snapshot") return "3D state";
  if (node.kind === "warning") return "attention";
  return node.kind;
}

function hysteresisExecutionTreeChildIcon(
  node: HysteresisExecutionTreeNode,
): ExplorerNode["icon"] {
  if (node.kind === "snapshot") return "database";
  if (node.kind === "warning") return "gauge";
  if (node.kind === "minimize") return "gauge";
  return "activity";
}

function lastNodeIdSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  return sanitizeExplorerIdSegment(value.split(":").filter(Boolean).at(-1));
}

function hysteresisSnapshotIdFromExecutionNode(
  node: HysteresisExecutionTreeNode,
): string | null {
  const selectionRefParts = node.selection_ref?.split(":").filter(Boolean);
  if (
    selectionRefParts?.[0] === "hysteresis-snapshot" &&
    selectionRefParts.length >= 4
  ) {
    return sanitizeExplorerIdSegment(selectionRefParts.at(-1));
  }

  const resourceSnapshotId = snapshotIdFromResourceRef(node.resource_ref);
  if (resourceSnapshotId) return resourceSnapshotId;

  return lastNodeIdSegment(node.node_id);
}

function snapshotIdFromResourceRef(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(value.slice(queryIndex + 1));
  return sanitizeExplorerIdSegment(params.get("snapshot_id"));
}

function sanitizeExplorerIdSegment(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const sanitized = value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

function activeExecutionTreeFieldNode(
  stage: ModelTreeStudyStageSnapshot,
): HysteresisExecutionTreeNode | null {
  const nodes = stage.hysteresisExecutionTree?.nodes;
  if (!nodes?.length) return null;
  const activePointIndex = stage.hysteresisExecutionTree?.active_point_index;
  return nodes.find(
    (node) =>
      node.kind === "field_point" &&
      (node.status === "active" ||
        (typeof activePointIndex === "number" && node.point_id === activePointIndex)),
  ) ?? null;
}

function hysteresisExecutionTreeBranchNodes(
  stage: ModelTreeStudyStageSnapshot,
): HysteresisExecutionTreeNode[] {
  return flattenHysteresisExecutionTreeNodes(
    stage.hysteresisExecutionTree?.nodes ?? [],
  ).filter((node) => node.kind === "branch");
}

function buildHysteresisPointSummaryNodes(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
  plannedPointCount: number | null,
  currentPointIndex: number | null,
): ExplorerNode[] {
  const children: ExplorerNode[] = [];
  if (currentPointIndex !== null && currentPointIndex > 0) {
    children.push({
      id: `${parentId}:completed`,
      kind: "study.stage.action",
      label: "Completed Points",
      parentId,
      badge: hysteresisPointRangeBadge(stage, 0, currentPointIndex - 1)
        ?? `${currentPointIndex} points`,
      icon: "database",
      stageId: nodeStageId,
      stageIndex: stage.index,
      status: "completed",
      contextCommands: ["workspace.focus-selection"],
    });
  }
  if (plannedPointCount !== null && currentPointIndex !== null) {
    const queuedCount = Math.max(0, plannedPointCount - currentPointIndex - 1);
    if (queuedCount > 0) {
      children.push({
        id: `${parentId}:queued`,
        kind: "study.stage.action",
        label: "Queued Points",
        parentId,
        badge: hysteresisPointRangeBadge(
          stage,
          currentPointIndex + 1,
          plannedPointCount - 1,
        ) ?? `${queuedCount} points`,
        icon: "database",
        stageId: nodeStageId,
        stageIndex: stage.index,
        status: "queued",
        contextCommands: ["workspace.focus-selection"],
      });
    }
  } else if (plannedPointCount !== null) {
    children.push({
      id: `${parentId}:planned`,
      kind: "study.stage.action",
      label: "Planned Points",
      parentId,
      badge: `${plannedPointCount} points`,
      icon: "database",
      stageId: nodeStageId,
      stageIndex: stage.index,
      status: stage.status === "completed" ? "completed" : "ready",
      contextCommands: ["workspace.focus-selection"],
    });
  }
  const bookmarkNodes = buildHysteresisBookmarkNodes(stage, parentId, nodeStageId);
  if (bookmarkNodes.length > 0) {
    const bookmarkNodeId = `${parentId}:bookmarks`;
    children.push({
      id: bookmarkNodeId,
      kind: "study.stage.action",
      label: "Bookmarks",
      parentId,
      badge: `${bookmarkNodes.length} ${bookmarkNodes.length === 1 ? "event" : "events"}`,
      icon: "database",
      stageId: nodeStageId,
      stageIndex: stage.index,
      status: "ready",
      contextCommands: ["workspace.focus-selection"],
      children: bookmarkNodes.map((node) => ({ ...node, parentId: bookmarkNodeId })),
    });
  }
  return children;
}

function buildHysteresisBookmarkNodes(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode[] {
  const interestingNodes = flattenHysteresisExecutionTreeNodes(
    stage.hysteresisExecutionTree?.nodes ?? [],
  ).filter(
    (node) =>
      node.kind === "bookmark" ||
      node.kind === "key_event" ||
      node.kind === "snapshot",
  );

  return interestingNodes.map((node, index) => {
    const snapshotId =
      node.kind === "snapshot" ? hysteresisSnapshotIdFromExecutionNode(node) : null;
    return {
      id: `${parentId}:bookmarks:${hysteresisExecutionTreeChildIdSuffix(node, index)}`,
      kind: "study.stage.action",
      label: node.label,
      parentId,
      badge: node.kind === "snapshot" ? "snapshot stored" : node.kind,
      icon: node.kind === "snapshot" ? "database" : "gauge",
      hysteresisExecutionNodeId: node.node_id,
      hysteresisExecutionNodeKind: node.kind,
      ...(typeof node.point_id === "number"
        ? { hysteresisPointId: node.point_id }
        : {}),
      ...(node.resource_ref ? { resourceRef: node.resource_ref } : {}),
      ...(typeof node.point_id === "number" && snapshotId
        ? {
            hysteresisPointId: node.point_id,
            hysteresisSnapshotId: snapshotId,
            resourceRef: node.resource_ref ?? undefined,
          }
        : {}),
      stageId: nodeStageId,
      stageIndex: stage.index,
      status: explorerStatusFromExecutionTree(node.status),
      contextCommands: ["workspace.focus-selection"],
    };
  });
}

function flattenHysteresisExecutionTreeNodes(
  nodes: readonly HysteresisExecutionTreeNode[],
): HysteresisExecutionTreeNode[] {
  const flattened: HysteresisExecutionTreeNode[] = [];
  for (const node of nodes) {
    flattened.push(node);
    if (node.children?.length) {
      flattened.push(...flattenHysteresisExecutionTreeNodes(node.children));
    }
  }
  return flattened;
}

function hysteresisFieldNodeSuffix(stage: ModelTreeStudyStageSnapshot): string {
  return typeof stage.hysteresisCurrentPointIndex === "number"
    ? `field-point:${stage.hysteresisCurrentPointIndex}`
    : "field-current";
}

function hysteresisPointRangeBadge(
  stage: ModelTreeStudyStageSnapshot,
  startPointIndex: number,
  endPointIndex: number,
): string | null {
  if (endPointIndex < startPointIndex) return null;
  const startField = hysteresisFieldAtPointIndex(stage, startPointIndex);
  const endField = hysteresisFieldAtPointIndex(stage, endPointIndex);
  if (startField === null || endField === null) return null;
  const count = endPointIndex - startPointIndex + 1;
  return `${formatSignedFieldMt(startField)} ... ${formatSignedFieldMt(endField)}, ${count} ${count === 1 ? "point" : "points"}`;
}

function hysteresisFieldAtPointIndex(
  stage: ModelTreeStudyStageSnapshot,
  pointIndex: number,
): number | null {
  const max = finiteNumberOrNull(stage.hysteresisFieldMaxMt);
  const min = finiteNumberOrNull(stage.hysteresisFieldMinMt);
  const step = finiteNumberOrNull(stage.hysteresisFieldStepMt);
  if (max === null || min === null || step === null || step <= 0 || pointIndex < 0) {
    return null;
  }
  const value = max - pointIndex * step;
  return value < min ? min : value;
}

function formatSignedFieldMt(value: number): string {
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  const formatted = Number.isInteger(normalized)
    ? normalized.toFixed(0)
    : normalized.toFixed(3).replace(/\.?0+$/, "");
  return `${normalized > 0 ? "+" : ""}${formatted} mT`;
}

function buildHysteresisAlgorithmNodes(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode[] {
  const steps = stage.hysteresisSettleSteps ?? [];
  const effectiveSteps = steps.length
    ? steps
    : stage.hysteresisCurrentSettleStepKind
      ? [
          {
            index: stage.hysteresisCurrentSettleStepIndex ?? 0,
            kind: stage.hysteresisCurrentSettleStepKind,
            method: stage.hysteresisCurrentSettleStepMethod ?? "runtime",
          },
        ]
      : [
          {
            index: 0,
            kind: "relax",
            method: "solver default",
          },
        ];
  return effectiveSteps.map((step, index) => ({
    id: `${parentId}:algorithm:${index}`,
    kind: "study.stage.action",
    label: hysteresisAlgorithmLabel(step.kind, index),
    parentId,
    badge: step.method ?? step.kind,
    icon: step.kind === "minimize" ? "gauge" : "activity",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: hysteresisAlgorithmStatus(stage, index),
    contextCommands: ["workspace.focus-selection"],
  }));
}

function hysteresisFieldLabel(stage: ModelTreeStudyStageSnapshot): string {
  if (stage.hysteresisCurrentFieldMt !== null && stage.hysteresisCurrentFieldMt !== undefined) {
    const point =
      typeof stage.hysteresisCurrentPointIndex === "number"
        ? ` / point ${stage.hysteresisCurrentPointIndex + 1}`
        : "";
    return `${stage.hysteresisCurrentFieldMt} mT${point}`;
  }
  const min = stage.hysteresisFieldMinMt ?? "?";
  const max = stage.hysteresisFieldMaxMt ?? "?";
  const step = stage.hysteresisFieldStepMt ?? "?";
  if (stage.status === "running") return `${min}..${max} mT`;
  return `${min}..${max} mT / step ${step}`;
}

function hysteresisPlanBadge(stage: ModelTreeStudyStageSnapshot): string {
  const min = stage.hysteresisFieldMinMt ?? "?";
  const max = stage.hysteresisFieldMaxMt ?? "?";
  const step = stage.hysteresisFieldStepMt ?? "?";
  return `${min}..${max} mT / step ${step}`;
}

function hysteresisProtocolBadge(stage: ModelTreeStudyStageSnapshot): string {
  const protocol = stage.hysteresisInitialProtocol ?? "as_authored";
  const branch = stage.hysteresisBranchMode ?? "custom";
  return `${protocol} / ${branch}`;
}

function hysteresisPointsBadge(
  plannedPointCount: number | null,
  currentOrdinal: number | null,
): string {
  if (plannedPointCount !== null && currentOrdinal !== null) {
    return `${currentOrdinal}/${plannedPointCount}`;
  }
  if (plannedPointCount !== null) return `${plannedPointCount} planned`;
  if (currentOrdinal !== null) return `point ${currentOrdinal}`;
  return "planned";
}

function hysteresisPlannedPointCount(
  stage: ModelTreeStudyStageSnapshot,
): number | null {
  const max = finiteNumberOrNull(stage.hysteresisFieldMaxMt);
  const min = finiteNumberOrNull(stage.hysteresisFieldMinMt);
  const step = finiteNumberOrNull(stage.hysteresisFieldStepMt);
  if (max === null || min === null || step === null || step === 0) return null;
  return Math.floor(Math.abs(max - min) / Math.abs(step)) + 1;
}

function hysteresisExecutionTreePointCount(
  stage: ModelTreeStudyStageSnapshot,
): number | null {
  const totalPoints = stage.hysteresisExecutionTree?.total_points;
  return typeof totalPoints === "number" && Number.isFinite(totalPoints)
    ? totalPoints
    : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function hysteresisStageStatus(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode["status"] {
  return stage.status === "completed" ? "completed" : stage.status ?? "ready";
}

function hysteresisAlgorithmLabel(kind: string, index: number): string {
  if (kind === "relax") return `Relax ${index + 1}`;
  if (kind === "minimize") return `Minimize ${index + 1}`;
  if (kind === "dynamics_settle") return `Dynamics settle ${index + 1}`;
  return `Algorithm ${index + 1}`;
}

function hysteresisAlgorithmStatus(
  stage: ModelTreeStudyStageSnapshot,
  index: number,
): ExplorerNode["status"] {
  const stageStatus = stage.status;
  if (stageStatus === "completed") return "completed";
  if (stageStatus === "failed") return "failed";
  const currentIndex = stage.hysteresisCurrentSettleStepIndex;
  if (typeof currentIndex === "number") {
    if (index < currentIndex) return "completed";
    if (index > currentIndex) return "queued";
    if (stageStatus === "paused") return "paused";
    if (stageStatus === "running") return "running";
    return "ready";
  }
  if (stageStatus === "running") return index === 0 ? "running" : "queued";
  if (stageStatus === "paused") return index === 0 ? "paused" : "queued";
  return "ready";
}

function explorerStatusFromExecutionTree(status: string): ExplorerNode["status"] {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "running";
  if (
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "paused" ||
    normalized === "completed" ||
    normalized === "skipped" ||
    normalized === "cancelled" ||
    normalized === "failed" ||
    normalized === "warning" ||
    normalized === "ready"
  ) {
    return normalized;
  }
  if (normalized === "done") return "completed";
  if (normalized === "error" || normalized === "rejected") return "failed";
  return "ready";
}
