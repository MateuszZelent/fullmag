import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

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
    buildHysteresisSaturationNode(stage, node.id, nodeStageId),
    buildHysteresisLiveRunNode(stage, node.id, nodeStageId),
    buildHysteresisBranchesNode(stage, node.id, nodeStageId),
    buildHysteresisPointsNode(stage, node.id, nodeStageId),
    buildHysteresisMetricsNode(stage, node.id, nodeStageId),
    buildHysteresisSnapshotsNode(stage, node.id, nodeStageId),
    buildHysteresisFieldNode(stage, node.id, nodeStageId),
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
    children: [
      buildHysteresisBranchNode(stage, branchesNodeId, nodeStageId, "forward", "Forward", "ready"),
      buildHysteresisBranchNode(stage, branchesNodeId, nodeStageId, "return", "Return", "queued"),
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
  const plannedPointCount = hysteresisPlannedPointCount(stage);
  const currentPointIndex =
    typeof stage.hysteresisCurrentPointIndex === "number"
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

function buildHysteresisFieldNode(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  nodeStageId: string,
): ExplorerNode {
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
      badge: `${currentPointIndex} points`,
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
        badge: `${queuedCount} points`,
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
  return children;
}

function hysteresisFieldNodeSuffix(stage: ModelTreeStudyStageSnapshot): string {
  return typeof stage.hysteresisCurrentPointIndex === "number"
    ? `field-point:${stage.hysteresisCurrentPointIndex}`
    : "field-current";
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
