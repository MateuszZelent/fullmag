import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ModelTreeStudyStageSnapshot,
} from "../../explorerTypes";

export const STUDY_STAGES_NODE_ID = "model:study:stages";

interface StudyStageNodeOptions {
  badge: string;
  icon: ExplorerNode["icon"];
  kind: ExplorerNode["kind"];
  label: string;
  stage: ModelTreeStudyStageSnapshot;
}

export function buildStudyStageBaseNode({
  badge,
  icon,
  kind,
  label,
  stage,
}: StudyStageNodeOptions): ExplorerNode {
  const nodeStageId = stage.stageId ?? `${stage.index}`;
  const nodeId = `model:study:stages:stage:${nodeStageId}`;
  return {
    id: nodeId,
    kind,
    label,
    parentId: STUDY_STAGES_NODE_ID,
    badge,
    icon,
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stage.status ?? "ready",
    contextCommands: [
      "study.remove-selected-stage",
      "study.skip",
      "workspace.focus-selection",
    ],
    children: buildStudyStageTransitionNodes(stage, nodeId, nodeStageId),
  };
}

export function formatStudyStageKind(kind: string): string {
  const parts: string[] = [];
  for (const part of kind.split("_")) {
    if (part) {
      parts.push(part[0]?.toUpperCase() + part.slice(1));
    }
  }
  return parts.join(" ");
}

export function finiteNumberFromScalar(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildStudyStageTransitionNodes(
  stage: ModelTreeStudyStageSnapshot,
  nodeId: string,
  nodeStageId: string,
): ExplorerNode[] {
  if (
    !stage.stateTransition &&
    !stage.stateTransitionKind &&
    !stage.stateTransitionReason
  ) {
    return [];
  }

  return [
    {
      id: `${nodeId}:state-transition`,
      kind: "study.stage.action",
      label: "State Transition",
      parentId: nodeId,
      badge:
        stage.stateTransition ??
        stage.stateTransitionKind ??
        stage.stateTransitionReason ??
        "transition",
      icon:
        stage.stateTransitionUiPresentation === "smooth_arrow"
          ? "activity"
          : "shield",
      stageId: nodeStageId,
      stageIndex: stage.index,
      status: studyStageTransitionStatus(stage),
      contextCommands: ["workspace.focus-selection"],
    },
  ];
}

function studyStageTransitionStatus(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNodeStatus {
  if (stage.stateTransitionUiPresentation === "error_boundary") {
    return "failed";
  }
  if (stage.stateTransitionUiPresentation === "boundary_bar") {
    return "warning";
  }
  return "ready";
}
