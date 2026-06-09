import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import {
  buildStudyStageBaseNode,
  formatStudyStageKind,
} from "./studyStageCommon";

export function buildActionStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const label = formatStudyStageKind(stage.kind) || "Stage";
  return buildStudyStageBaseNode({
    badge: stage.artifactName ?? stage.kind,
    icon: "activity",
    kind: "study.stage.action",
    label: `${label} ${stage.index + 1}`,
    stage,
  });
}
