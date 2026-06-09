import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildFrequencyResponseStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: stage.artifactName ?? "frequency sweep",
    icon: "activity",
    kind: "study.stage.frequency_response",
    label: `Frequency Response ${stage.index + 1}`,
    stage,
  });
}
