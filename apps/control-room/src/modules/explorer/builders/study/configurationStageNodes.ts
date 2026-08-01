import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

export function buildTableAutosaveStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: "table clock",
    icon: "activity",
    kind: "study.stage.table_autosave",
    label: `Table Autosave ${stage.index + 1}`,
    stage,
  });
}

export function buildAutosaveStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: "output state",
    icon: "database",
    kind: "study.stage.autosave",
    label: `Autosave ${stage.index + 1}`,
    stage,
  });
}

export function buildFftResponseStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  return buildStudyStageBaseNode({
    badge: "response FFT",
    icon: "activity",
    kind: "study.stage.fft_response",
    label: `FFT Response ${stage.index + 1}`,
    stage,
  });
}
