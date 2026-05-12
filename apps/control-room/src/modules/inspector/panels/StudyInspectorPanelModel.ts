import type {
  CurrentRunResource,
  JsonObject,
  SceneResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";

export interface StudyStageSnapshot {
  algorithm: string | null;
  energyTolerance: string | null;
  index: number;
  kind: string;
  maxSteps: string | null;
  status: string;
  torqueTolerance: string | null;
  untilSeconds: string | null;
}

export type StudyStageModel = StudyStageSnapshot & {
  label: string;
  progressPercent: number;
};

export interface StudyInspectorSnapshot {
  boundary: {
    demagRealization: string;
    externalField: string;
  };
  requested: {
    backend: string;
    device: string;
    mode: string;
    precision: string;
  };
  stages: StudyStageSnapshot[];
}

export interface StudyInspectorModel {
  boundary: StudyInspectorSnapshot["boundary"];
  requested: StudyInspectorSnapshot["requested"];
  runtime: {
    activeStageLabel: string;
    maxTorque: string;
    progressPercent: number;
    runId: string;
    state: string;
  };
  selectedStage: StudyStageModel | null;
  stages: StudyStageModel[];
}

interface ResolveStudyInspectorModelInput {
  currentRun: CurrentRunResource | null;
  selectedNodeId: string | null;
  snapshot: StudyInspectorSnapshot;
  solverStatus: SolverStatusResource | null;
  stageExecution: StageExecutionResource | null;
}

type JsonRecord = Record<string, unknown>;

export function studySnapshotFromScene(
  scene: SceneResource | null | undefined,
): StudyInspectorSnapshot {
  const study = asRecord(asRecord(scene)?.study);
  const stages = Array.isArray(study?.stages) ? study.stages : [];

  return {
    boundary: {
      demagRealization: stringValue(study?.demag_realization, "default"),
      externalField: formatExternalField(study?.external_field),
    },
    requested: {
      backend: stringValue(study?.requested_backend, "auto"),
      device: stringValue(study?.requested_device, "auto"),
      mode: stringValue(study?.requested_mode, "strict"),
      precision: stringValue(study?.requested_precision, "double"),
    },
    stages: stages.map((stage, index) => stageSnapshot(stage, index)),
  };
}

export function resolveStudyInspectorModel({
  currentRun,
  selectedNodeId,
  snapshot,
  solverStatus,
  stageExecution,
}: ResolveStudyInspectorModelInput): StudyInspectorModel {
  const activeStageIndex =
    stageExecution?.active_stage_index ?? currentRun?.active_stage_index ?? null;
  const selectedStageIndex = selectedStageIndexFromNode(selectedNodeId);
  const progressPercent = resolveProgressPercent({
    currentRun,
    solverStatus,
    selectedStage:
      snapshot.stages[selectedStageIndex ?? activeStageIndex ?? -1] ?? null,
  });
  const stages = snapshot.stages.map((stage) => ({
    ...stage,
    label: stageLabel(stage),
    progressPercent: stage.index === activeStageIndex ? progressPercent : 0,
    status: stageExecution?.stage_statuses[stage.index] ?? stage.status,
  }));
  const selectedStage =
    stages[selectedStageIndex ?? activeStageIndex ?? -1] ?? null;
  const activeStage = stages[activeStageIndex ?? -1] ?? null;

  return {
    boundary: snapshot.boundary,
    requested: snapshot.requested,
    runtime: {
      activeStageLabel: activeStage ? activeStage.label : "No active stage",
      maxTorque: formatTorque(solverStatus?.max_torque),
      progressPercent,
      runId: currentRun?.run_id ?? "none",
      state:
        solverStatus?.runtime_state ??
        currentRun?.status ??
        stageExecution?.runtime_state ??
        "idle",
    },
    selectedStage,
    stages,
  };
}

function stageSnapshot(value: unknown, index: number): StudyStageSnapshot {
  const stage = asRecord(value);
  const kind = stringValue(stage?.kind ?? stage?.entrypoint_kind, "stage");

  return {
    algorithm: optionalString(stage?.relax_algorithm ?? stage?.algorithm),
    energyTolerance: optionalScalarText(stage?.energy_tolerance),
    index,
    kind,
    maxSteps: optionalScalarText(stage?.max_steps),
    status: "queued",
    torqueTolerance: optionalScalarText(stage?.torque_tolerance),
    untilSeconds: optionalScalarText(stage?.until_seconds),
  };
}

function stageLabel(stage: StudyStageSnapshot): string {
  const base =
    stage.kind === "relax"
      ? "Relax"
      : stage.kind === "run"
        ? "Run"
        : titleCase(stage.kind);
  return `${base} ${stage.index + 1}`;
}

function resolveProgressPercent({
  currentRun,
  solverStatus,
  selectedStage,
}: {
  currentRun: CurrentRunResource | null;
  solverStatus: SolverStatusResource | null;
  selectedStage: StudyStageSnapshot | null;
}): number {
  const steps = solverStatus?.step_index ?? currentRun?.total_steps ?? null;
  const maxSteps =
    selectedStage?.maxSteps === null ? null : Number(selectedStage?.maxSteps);
  if (!steps || !maxSteps || !Number.isFinite(maxSteps) || maxSteps <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (steps / maxSteps) * 100));
}

function selectedStageIndexFromNode(nodeId: string | null): number | null {
  const match = nodeId?.match(/:stage:(\d+)$/);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function formatExternalField(value: unknown): string {
  const vector = Array.isArray(value) ? value : [];
  if (
    vector.length !== 3 ||
    !vector.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return "0, 0, 0 T";
  }
  return `${vector.join(", ")} T`;
}

function formatTorque(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(3)} T`
    : "unavailable";
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function optionalScalarText(value: unknown): string | null {
  return typeof value === "number" || typeof value === "string"
    ? String(value)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringValue(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
