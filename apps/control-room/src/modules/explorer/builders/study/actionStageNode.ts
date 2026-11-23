import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import {
  buildStudyStageBaseNode,
  formatStudyStageKind,
} from "./studyStageCommon";

// Stage actions of a mask antenna (ADR 0081) read as in the exported script and route to study.stage.mask_field_drive.
const MASK_ANTENNA_STAGE_LABELS: Record<string, string> = {
  add_mask_field_drive: "Add Antenna",
  update_mask_field_drive: "Update Antenna",
};

export function buildActionStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const normalizedKind = stage.kind.toLowerCase();
  const isMaskAntennaStage = normalizedKind in MASK_ANTENNA_STAGE_LABELS;
  const label =
    MASK_ANTENNA_STAGE_LABELS[normalizedKind] ||
    formatStudyStageKind(stage.kind) ||
    "Stage";
  return buildStudyStageBaseNode({
    badge: stage.artifactName ?? stage.kind,
    icon: "activity",
    kind: isMaskAntennaStage ? "study.stage.mask_field_drive" : "study.stage.action",
    label: `${label} ${stage.index + 1}`,
    stage,
  });
}
