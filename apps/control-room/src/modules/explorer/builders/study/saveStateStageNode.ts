import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildSaveStateStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: stage.artifactName ?? "snapshot",
    icon: "file",
    kind: "study.stage.save_state",
    label: `Save State ${stage.index + 1}`,
    stage,
  });
}
