export type StudyStageNodeSource = "pipeline" | "flat";

export type StudyStageDetailSection =
  | "overview"
  | "solver"
  | "time-range"
  | "stop-criteria"
  | "equilibrium"
  | "operator"
  | "sweep"
  | "settle"
  | "outputs"
  | "materialized";

export type StudyNodeContext =
  | { kind: "simulation-root" }
  | { kind: "study-root" }
  | { kind: "study-stages" }
  | { kind: "study-stage-empty" }
  | {
      kind: "study-stage";
      source: StudyStageNodeSource;
      stageKey: string;
      detail: StudyStageDetailSection | null;
    };

export function buildPipelineStudyStageNodeId(
  nodeId: string,
  detail?: StudyStageDetailSection,
): string {
  return detail ? `study-stage-node:${nodeId}/${detail}` : `study-stage-node:${nodeId}`;
}

export function buildFlatStudyStageNodeId(
  index: number,
  detail?: StudyStageDetailSection,
): string {
  return detail ? `study-stage-flat:${index}/${detail}` : `study-stage-flat:${index}`;
}

export function isStudyNodeId(nodeId: string | null | undefined): boolean {
  return parseStudyNodeContext(nodeId) !== null;
}

export function parseStudyNodeContext(
  nodeId: string | null | undefined,
): StudyNodeContext | null {
  if (!nodeId) return null;
  if (nodeId === "study-root") return { kind: "simulation-root" };
  if (nodeId === "study") return { kind: "study-root" };
  if (nodeId === "study-defaults") return { kind: "study-stages" };
  if (nodeId === "study-defaults-runtime") return { kind: "study-stages" };
  if (
    nodeId === "study-defaults-solver" ||
    nodeId === "study-solver" ||
    nodeId === "study-integrator" ||
    nodeId === "study-time" ||
    nodeId === "study-convergence" ||
    nodeId === "study-relax"
  ) {
    return { kind: "study-stages" };
  }
  if (nodeId === "study-defaults-physics") return { kind: "study-stages" };
  if (nodeId === "study-defaults-outputs") return { kind: "study-stages" };
  if (
    nodeId === "study-stages" ||
    nodeId === "study-builder" ||
    nodeId === "study-stage-sequence" ||
    nodeId === "study-setup" ||
    nodeId === "study-pipeline"
  ) {
    return { kind: "study-stages" };
  }
  if (nodeId === "study-stage-empty") return { kind: "study-stage-empty" };

  const pipelineMatch = nodeId.match(
    /^study-stage-node:(.+?)(?:\/(overview|solver|time-range|stop-criteria|equilibrium|operator|sweep|settle|outputs|materialized))?$/,
  );
  if (pipelineMatch) {
    return {
      kind: "study-stage",
      source: "pipeline",
      stageKey: pipelineMatch[1] ?? "",
      detail: (pipelineMatch[2] as StudyStageDetailSection | undefined) ?? null,
    };
  }

  const flatMatch = nodeId.match(
    /^study-stage-flat:(\d+)(?:\/(overview|solver|time-range|stop-criteria|equilibrium|operator|sweep|settle|outputs|materialized))?$/,
  );
  if (flatMatch) {
    return {
      kind: "study-stage",
      source: "flat",
      stageKey: flatMatch[1] ?? "",
      detail: (flatMatch[2] as StudyStageDetailSection | undefined) ?? null,
    };
  }

  const legacyFlatMatch = nodeId.match(/^study-stage-(\d+)$/);
  if (legacyFlatMatch) {
    return {
      kind: "study-stage",
      source: "flat",
      stageKey: legacyFlatMatch[1] ?? "",
      detail: null,
    };
  }

  return null;
}
