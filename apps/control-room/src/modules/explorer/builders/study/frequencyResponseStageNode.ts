import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

const RESPONSE_DETAIL_NODES: readonly {
  badge: string;
  icon: ExplorerNode["icon"];
  key: string;
  kind: ExplorerNode["kind"];
  label: string;
}[] = [
  {
    badge: "intent",
    icon: "settings",
    key: "setup",
    kind: "study.stage.frequency_response.setup",
    label: "Setup",
  },
  {
    badge: "FMR / map",
    icon: "sparkles",
    key: "calculation-mode",
    kind: "study.stage.frequency_response.calculation_mode",
    label: "Calculation Mode",
  },
  {
    badge: "linearization",
    icon: "magnet",
    key: "equilibrium",
    kind: "study.stage.frequency_response.equilibrium",
    label: "Equilibrium",
  },
  {
    badge: "LLG",
    icon: "activity",
    key: "operator",
    kind: "study.stage.frequency_response.operator",
    label: "Operator",
  },
  {
    badge: "boundary",
    icon: "shield",
    key: "boundary",
    kind: "study.stage.frequency_response.boundary",
    label: "Boundary",
  },
  {
    badge: "PBC",
    icon: "layers",
    key: "periodic-pairs",
    kind: "study.stage.frequency_response.periodic_pairs",
    label: "Periodic Pairs",
  },
  {
    badge: "future",
    icon: "wave",
    key: "k-grid",
    kind: "study.stage.frequency_response.k_grid",
    label: "k/f Grid",
  },
  {
    badge: "drive",
    icon: "magnet",
    key: "excitation",
    kind: "study.stage.frequency_response.excitation",
    label: "Excitation",
  },
  {
    badge: "frequency",
    icon: "activity",
    key: "sweep",
    kind: "study.stage.frequency_response.sweep",
    label: "Sweep",
  },
  {
    badge: "driven",
    icon: "gauge",
    key: "solver",
    kind: "study.stage.frequency_response.solver",
    label: "Solver",
  },
  {
    badge: "artifacts",
    icon: "file",
    key: "outputs",
    kind: "study.stage.frequency_response.outputs",
    label: "Outputs",
  },
  {
    badge: "checks",
    icon: "database",
    key: "diagnostics",
    kind: "study.stage.frequency_response.diagnostics",
    label: "Diagnostics",
  },
];

export function buildFrequencyResponseStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  const node = buildStudyStageBaseNode({
    badge: stage.artifactName ?? "frequency sweep",
    icon: "activity",
    kind: "study.stage.frequency_response",
    label: `Frequency Response ${stage.index + 1}`,
    stage,
  });
  node.children = [
    ...(node.children ?? []),
    ...buildFrequencyResponseDetailNodes(
      stage,
      node.id,
      node.stageId ?? `${stage.index}`,
    ),
  ];
  return node;
}

function buildFrequencyResponseDetailNodes(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  stageId: string,
): ExplorerNode[] {
  return RESPONSE_DETAIL_NODES.map((detail) => ({
    id: `${parentId}:${detail.key}`,
    kind: detail.kind,
    label: detail.label,
    parentId,
    badge: detail.badge,
    icon: detail.icon,
    stageId,
    stageIndex: stage.index,
    status: stage.status ?? "ready",
    contextCommands: ["workspace.focus-selection"],
  }));
}
