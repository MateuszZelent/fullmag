import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

type FrequencyResponseDetailNodeDefinition = {
  badge: string;
  icon: ExplorerNode["icon"];
  key: string;
  kind: ExplorerNode["kind"];
  label: string;
};

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
  const details: FrequencyResponseDetailNodeDefinition[] = [
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
  ];

  if (hasNonFreeBoundary(stage)) {
    details.push({
      badge: "boundary",
      icon: "shield",
      key: "boundary",
      kind: "study.stage.frequency_response.boundary",
      label: "Boundary",
    });
  }
  if (hasPeriodicBoundary(stage)) {
    details.push({
      badge: "PBC",
      icon: "layers",
      key: "periodic-pairs",
      kind: "study.stage.frequency_response.periodic_pairs",
      label: "Periodic Pairs",
    });
  }
  if (requestsResponseMap(stage)) {
    details.push({
      badge: "future",
      icon: "wave",
      key: "k-grid",
      kind: "study.stage.frequency_response.k_grid",
      label: "k/f Grid",
    });
  }

  details.push(
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
  );

  return details.map((detail) => ({
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

function hasNonFreeBoundary(stage: ModelTreeStudyStageSnapshot): boolean {
  const boundary = normalizedToken(stage.boundaryCondition);
  return boundary !== null && boundary !== "free" && boundary !== "open";
}

function hasPeriodicBoundary(stage: ModelTreeStudyStageSnapshot): boolean {
  const boundary = normalizedToken(stage.boundaryCondition);
  return boundary === "periodic" || boundary === "floquet";
}

function requestsResponseMap(stage: ModelTreeStudyStageSnapshot): boolean {
  const calculationMode = normalizedToken(stage.calculationMode);
  const sampling = normalizedToken(stage.kSamplingKind);
  return (
    calculationMode === "response_map" ||
    sampling === "path" ||
    sampling === "grid" ||
    sampling === "explicit"
  );
}

function normalizedToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase();
  return token ? token : null;
}
