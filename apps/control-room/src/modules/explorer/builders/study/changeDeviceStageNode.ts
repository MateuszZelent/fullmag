import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildChangeDeviceStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: stage.device ?? "device",
    icon: "settings",
    kind: "study.stage.change_device",
    label: `Change Device ${stage.index + 1}`,
    stage,
  });
}
