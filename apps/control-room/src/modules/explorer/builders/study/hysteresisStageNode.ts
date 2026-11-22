import type {
  ExplorerNode,
  ModelTreeStudyStageSnapshot,
} from "../../explorerTypes";
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
  return {
    ...node,
    children: [],
  };
}
