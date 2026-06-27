import type { ExplorerNode, ModelTreeStudyStageSnapshot } from "../../explorerTypes";
import { buildStudyStageBaseNode } from "./studyStageCommon";

type EigenmodesDetailNodeDefinition = {
  badge: string;
  icon: ExplorerNode["icon"];
  key: string;
  kind: ExplorerNode["kind"];
  label: string;
};

export function buildEigenmodesStageNode(
  stage: ModelTreeStudyStageSnapshot,
): ExplorerNode {
  const node = buildStudyStageBaseNode({
    badge: stage.artifactName ?? "modes",
    icon: "activity",
    kind: "study.stage.eigenmodes",
    label: `Eigenmodes ${stage.index + 1}`,
    stage,
  });
  node.children = [
    ...(node.children ?? []),
    ...buildEigenmodesDetailNodes(stage, node.id, node.stageId ?? `${stage.index}`),
  ];
  return node;
}

function buildEigenmodesDetailNodes(
  stage: ModelTreeStudyStageSnapshot,
  parentId: string,
  stageId: string,
): ExplorerNode[] {
  const details: EigenmodesDetailNodeDefinition[] = [
    {
      badge: "intent",
      icon: "settings",
      key: "setup",
      kind: "study.stage.eigenmodes.setup",
      label: "Setup",
    },
    {
      badge: "FMR / dispersion",
      icon: "sparkles",
      key: "calculation-mode",
      kind: "study.stage.eigenmodes.calculation_mode",
      label: "Calculation Mode",
    },
    {
      badge: "linearization",
      icon: "magnet",
      key: "equilibrium",
      kind: "study.stage.eigenmodes.equilibrium",
      label: "Equilibrium",
    },
    {
      badge: "LLG",
      icon: "activity",
      key: "operator",
      kind: "study.stage.eigenmodes.operator",
      label: "Operator",
    },
  ];

  if (hasNonFreeBoundary(stage)) {
    details.push({
      badge: "boundary",
      icon: "shield",
      key: "boundary",
      kind: "study.stage.eigenmodes.boundary",
      label: "Boundary",
    });
  }
  if (hasPeriodicBoundary(stage)) {
    details.push({
      badge: "PBC",
      icon: "layers",
      key: "periodic-pairs",
      kind: "study.stage.eigenmodes.periodic_pairs",
      label: "Periodic Pairs",
    });
  }
  if (hasKSpectralSampling(stage)) {
    details.push({
      badge: "Bloch",
      icon: "wave",
      key: "k-path",
      kind: "study.stage.eigenmodes.k_path",
      label: "k-Path",
    });
  }

  details.push(
    {
      badge: "modal",
      icon: "gauge",
      key: "solver",
      kind: "study.stage.eigenmodes.solver",
      label: "Solver",
    },
    {
      badge: "artifacts",
      icon: "file",
      key: "outputs",
      kind: "study.stage.eigenmodes.outputs",
      label: "Outputs",
    },
    {
      badge: "checks",
      icon: "database",
      key: "diagnostics",
      kind: "study.stage.eigenmodes.diagnostics",
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

function hasKSpectralSampling(stage: ModelTreeStudyStageSnapshot): boolean {
  const sampling = normalizedToken(stage.kSamplingKind);
  return sampling === "path" || sampling === "grid" || sampling === "explicit";
}

function normalizedToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase();
  return token ? token : null;
}
