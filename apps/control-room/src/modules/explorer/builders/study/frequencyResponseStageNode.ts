import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

/**
 * Builds the consolidated single-leaf Explorer node for `study.stage.frequency_response`.
 * All setup, excitation, sweep, and solver sections live in the 3-tab
 * `FrequencyResponseStageSpec` inside `InspectorTemplate` (Volume V §3.5).
 */
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
