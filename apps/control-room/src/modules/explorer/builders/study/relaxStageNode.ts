import { formatTorqueT, teslaFromApm } from "@/shared/domain/physics/torqueUnits";

import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import {
  buildStudyStageBaseNode,
  finiteNumberFromScalar,
} from "./studyStageCommon";

export function buildRelaxStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const torqueToleranceApm = finiteNumberFromScalar(stage.torqueTolerance);
  const badge =
    torqueToleranceApm !== null
      ? `tau ${formatTorqueT(teslaFromApm(torqueToleranceApm))}`
      : stage.maxSteps != null
        ? `${stage.maxSteps} steps`
        : "relax";

  return buildStudyStageBaseNode({
    badge,
    icon: "play",
    kind: "study.stage.relax",
    label: `Relax ${stage.index + 1}`,
    stage,
  });
}
