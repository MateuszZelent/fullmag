import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildEigenmodesStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: stage.artifactName ?? "modes",
    icon: "activity",
    kind: "study.stage.eigenmodes",
    label: `Eigenmodes ${stage.index + 1}`,
    stage,
  });
}
