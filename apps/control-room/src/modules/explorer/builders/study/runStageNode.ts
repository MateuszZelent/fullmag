import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildRunStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  return buildStudyStageBaseNode({
    badge:
      stage.untilSeconds != null
        ? `${stage.untilSeconds} s`
        : stage.maxSteps != null
          ? `${stage.maxSteps} steps`
          : "time domain",
    icon: "play",
    kind: "study.stage.run",
    label: `Run ${stage.index + 1}`,
    stage,
  });
}
