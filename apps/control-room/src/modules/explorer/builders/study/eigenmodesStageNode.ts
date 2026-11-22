import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

/**
 * Builds the consolidated single-leaf Explorer node for `study.stage.eigenmodes`.
 * All setup, operator, wavevector, and solver sections live in the 3-tab
 * `EigenmodesStageSpec` inside `InspectorTemplate` (Volume V §3.5).
 */
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
