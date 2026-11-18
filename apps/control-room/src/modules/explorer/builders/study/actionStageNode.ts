import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import {
  buildStudyStageBaseNode,
  formatStudyStageKind,
} from "./studyStageCommon";

// Stage actions of a mask antenna (ADR 0081) read as in the exported script.
const MASK_ANTENNA_STAGE_LABELS: Record<string, string> = {
  add_mask_field_drive: "Add Antenna",
  update_mask_field_drive: "Update Antenna",
};

export function buildActionStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const label =
    MASK_ANTENNA_STAGE_LABELS[stage.kind.toLowerCase()] ||
    formatStudyStageKind(stage.kind) ||
    "Stage";
  return buildStudyStageBaseNode({
    badge: stage.artifactName ?? stage.kind,
    icon: "activity",
    kind: "study.stage.action",
    label: `${label} ${stage.index + 1}`,
    stage,
  });
}
