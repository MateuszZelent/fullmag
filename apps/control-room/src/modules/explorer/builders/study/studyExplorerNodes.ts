import type {
  ExplorerNode,
  ModelTreeSnapshot,
  ModelTreeStudyStageSnapshot,
} from "../../explorerTypes";
import { buildActionStageNode } from "./actionStageNode";
import { buildChangeDeviceStageNode } from "./changeDeviceStageNode";
import { buildEigenmodesStageNode } from "./eigenmodesStageNode";
import { buildFrequencyResponseStageNode } from "./frequencyResponseStageNode";
import { buildHysteresisStageNode } from "./hysteresisStageNode";
import { buildRelaxStageNode } from "./relaxStageNode";
import { buildRunStageNode } from "./runStageNode";
import { buildSaveStateStageNode } from "./saveStateStageNode";
import { STUDY_STAGES_NODE_ID } from "./studyStageCommon";

const STUDY_ADD_STAGE_COMMANDS = [
  "study.add-relax-stage",
  "study.add-run-stage",
  "study.add-hysteresis-stage",
  "study.add-eigenmodes-stage",
  "study.add-frequency-response-stage",
  "study.add-save-state-stage",
];

const STUDY_EXECUTION_COMMANDS = [
  "study.run",
  "study.pause",
  "study.resume",
  "study.stop",
  "study.skip",
  "study.compute-fields",
  "study.compute-energies",
];

const STUDY_RECOVERY_COMMANDS = [
  "study.save-checkpoint",
  "study.restore-checkpoint",
  "study.import-state",
  "study.export-state",
  "study.discard-paused-state",
];

export function buildStudyNodes(study: ModelTreeSnapshot["study"]): ExplorerNode {
  const stages = study?.stages ?? [];
  return {
    id: "model:study",
    kind: "study.root",
    label: "Study",
    parentId: "model:session",
    badge: `${stages.length} ${stages.length === 1 ? "stage" : "stages"}`,
    icon: "play",
    status: "ready",
    contextCommands: [
      "explorer.expand-all",
      "explorer.collapse-all",
      "workspace.focus-selection",
    ],
    children: [
      buildStudyStagesNode(stages),
      buildStudyExecutionNode(),
      buildStudyRecoveryNode(),
    ],
  };
}

function buildStudyStagesNode(
  stages: readonly ModelTreeStudyStageSnapshot[],
): ExplorerNode {
  return {
    id: STUDY_STAGES_NODE_ID,
    kind: "study.stages",
    label: "Stages",
    parentId: "model:study",
    badge: `${stages.length}`,
    icon: "layers",
    status: stages.length > 0 ? "ready" : "stale",
    contextCommands: STUDY_ADD_STAGE_COMMANDS,
    children: stages.map(buildStudyStageNode),
  };
}

function buildStudyExecutionNode(): ExplorerNode {
  return {
    id: "model:study:execution",
    kind: "study.execution",
    label: "Execution",
    parentId: "model:study",
    badge: "runtime",
    icon: "play",
    status: "ready",
    contextCommands: STUDY_EXECUTION_COMMANDS,
  };
}

function buildStudyRecoveryNode(): ExplorerNode {
  return {
    id: "model:study:recovery",
    kind: "study.recovery",
    label: "Recovery",
    parentId: "model:study",
    badge: "state",
    icon: "database",
    status: "ready",
    contextCommands: STUDY_RECOVERY_COMMANDS,
  };
}

function buildStudyStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const normalized = stage.kind.toLowerCase();
  if (normalized === "relax") return buildRelaxStageNode(stage);
  if (normalized === "run") return buildRunStageNode(stage);
  if (normalized === "change_device") return buildChangeDeviceStageNode(stage);
  if (normalized === "hysteresis") return buildHysteresisStageNode(stage);
  if (normalized === "eigenmodes") return buildEigenmodesStageNode(stage);
  if (normalized === "frequency_response") {
    return buildFrequencyResponseStageNode(stage);
  }
  if (normalized === "save_state") return buildSaveStateStageNode(stage);
  return buildActionStageNode(stage);
}
