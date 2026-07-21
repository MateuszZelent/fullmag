import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildAddFieldDriveStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: "field drive",
    icon: "magnet",
    kind: "study.stage.add_field_drive",
    label: `Add Antenna ${stage.index + 1}`,
    stage,
  });
}
