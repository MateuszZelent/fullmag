import type {
  CommandQueueStatusResource,
  CurrentRunResource,
  JsonObject,
  SceneResource,
  SolverEnergyHistoryResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import {
  apmFromTesla,
  formatScientific,
  formatTorquePairFromApm,
  formatTorquePairFromTesla,
  formatTorqueT,
  teslaFromApm,
} from "@/shared/domain/physics/torqueUnits";

interface StudyStageSnapshot {
  algorithm: string | null;
  energyTolerance: string | null;
  index: number;
  kind: string;
  maxSteps: string | null;
  stageId: string | null;
  status: string;
  torqueTolerance: string | null;
  torqueToleranceFormatted: string | null;
  torqueToleranceShortFormatted: string | null;
  timeBudgetKind: "physical" | "pseudo";
  untilSeconds: string | null;
}

interface StudyRelaxTorqueStopModel {
  current: string;
  status: string;
  threshold: string;
}

interface StudyStageRuntimeMetricModel {
  name: string;
  threshold: string;
  value: string;
  rawValue?: number | null;
}

interface StudyStageTransitionModel {
  kind: string | null;
  label: string | null;
  reason: string | null;
  transferOperator: string | null;
  uiPresentation: string | null;
}

export type StudyStageModel = StudyStageSnapshot & {
  artifactRefs: readonly string[];
  checkpointRef: string | null;
  commandId: string | null;
  completedAtIso: string | null;
  completedAtUnixMs: number | null;
  label: string;
  lastProgressUnixMs?: number | null;
  startedAtUnixMs?: number | null;
  progressDetail?: string | null;
  progressLabel?: string | null;
  progressPercent: number;
  runtimeMetric: StudyStageRuntimeMetricModel | null;
  stopReason: string | null;
  transition: StudyStageTransitionModel | null;
};

export interface StudyInspectorSnapshot {
  boundary: {
    demagEnabled: string;
    demagRealization: string;
    exchangeEnabled: string;
    externalField: string;
    femDemagSolverPolicy: string;
    solver: string;
  };
  requested: {
    backend: string;
    cpuThreads: string;
    device: string;
    mode: string;
    precision: string;
  };
  stages: StudyStageSnapshot[];
}

interface StudyRelaxEnergyStopModel {
  current: string;
  status: string;
  threshold: string;
}

interface StudyRelaxTimeStopModel {
  budget: string;
  elapsed: string;
  status: string;
}

export interface StudyInspectorModel {
  boundary: StudyInspectorSnapshot["boundary"];
  requested: StudyInspectorSnapshot["requested"];
  runtime: {
    activeStageLabel: string;
    commandBadge: string;
    commandError: string | null;
    commandId: string | null;
    commandLabel: string;
    maxTorque: string;
    progressPercent: number;
    relaxEnergyStop: StudyRelaxEnergyStopModel | null;
    relaxTimeStop: StudyRelaxTimeStopModel | null;
    relaxTorqueStop: StudyRelaxTorqueStopModel | null;
    runId: string;
    state: string;
  };
  selectedStage: StudyStageModel | null;
  stages: StudyStageModel[];
}

interface ResolveStudyInspectorModelInput {
  commandQueue?: CommandQueueStatusResource | null;
  currentRun: CurrentRunResource | null;
  energyHistory?: SolverEnergyHistoryResource | null;
  selectedNodeId?: string | null;
  selectedStageRef?: {
    nodeId: string | null;
    stageId?: string | null;
    stageIndex?: number | null;
  } | null;
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
      demagEnabled: booleanLabel(study?.demag_enabled, true),
      demagRealization: stringValue(study?.demag_realization, "default"),
      exchangeEnabled: booleanLabel(study?.exchange_enabled, true),
      externalField: formatExternalField(study?.external_field),
      femDemagSolverPolicy: objectSummary(study?.fem_demag_solver_policy),
      solver: objectSummary(study?.solver),
    },
    requested: {
      backend: stringValue(study?.requested_backend, "auto"),
      cpuThreads: optionalScalarValue(study?.requested_cpu_threads, "auto"),
      device: stringValue(study?.requested_device, "auto"),
      mode: stringValue(study?.requested_mode, "strict"),
      precision: stringValue(study?.requested_precision, "double"),
    },
    stages: stages.map((stage, index) => stageSnapshot(stage, index)),
  };
}

export function resolveStudyInspectorModel({
  commandQueue,
  currentRun,
  energyHistory,
  selectedNodeId,
  selectedStageRef,
  snapshot,
  solverStatus,
  stageExecution,
}: ResolveStudyInspectorModelInput): StudyInspectorModel {
  const activeStageIndex =
    stageExecution?.active_stage_index ?? currentRun?.active_stage_index ?? null;
  const selectedStageIndex =
    selectedStageIndexFromId(
      selectedStageRef?.stageId ?? null,
      snapshot.stages,
      stageExecution,
    ) ??
    selectedStageRef?.stageIndex ??
    selectedStageIndexFromNode(selectedNodeId ?? null, snapshot.stages, stageExecution);
  const activeStageSnapshot = snapshot.stages[activeStageIndex ?? -1] ?? null;
  const progressPercent = resolveProgressPercent({
    currentRun,
    solverStatus,
    selectedStage: activeStageSnapshot,
  });

  const runtimeStageByIndex = new Map(
    (stageExecution?.stages ?? []).map((stage, index) => [
      typeof stage.index === "number" ? stage.index : index,
      stage,
    ]),
  );

  const stages = snapshot.stages.map((stage) => {
    const runtimeRecord = runtimeStageByIndex.get(stage.index) ?? null;
    const status =
      runtimeRecord?.status ??
      stageExecution?.stage_statuses[stage.index] ??
      stage.status;
    const isCompleted = status.toLowerCase() === "completed";
    const stageProgressPercent =
      typeof runtimeRecord?.progress_percent === "number" &&
      Number.isFinite(runtimeRecord.progress_percent)
        ? Math.max(0, Math.min(100, runtimeRecord.progress_percent))
        : null;
    return {
      ...stage,
      artifactRefs: runtimeRecord?.artifact_refs ?? [],
      checkpointRef: runtimeRecord?.checkpoint_ref ?? null,
      commandId: runtimeRecord?.command_id ?? null,
      completedAtIso:
        typeof runtimeRecord?.completed_at_unix_ms === "number"
          ? new Date(runtimeRecord.completed_at_unix_ms).toISOString()
          : null,
      completedAtUnixMs: runtimeRecord?.completed_at_unix_ms ?? null,
      label: stageLabel(stage),
      lastProgressUnixMs: runtimeRecord?.last_progress_unix_ms ?? null,
      startedAtUnixMs: runtimeRecord?.started_at_unix_ms ?? null,
      progressDetail: runtimeRecord?.progress_detail ?? null,
      progressLabel: runtimeRecord?.progress_label ?? null,
      progressPercent: isCompleted
        ? 100
        : stage.index === activeStageIndex
          ? (stageProgressPercent ?? progressPercent)
          : 0,
      runtimeMetric: runtimeMetricModel(runtimeRecord),
      stageId: runtimeRecord?.stage_id ?? stage.stageId,
      status,
      stopReason: runtimeRecord?.reason ?? null,
      transition: stageTransitionModel(runtimeRecord),
    };
  });
  const selectedStage =
    stages[selectedStageIndex ?? activeStageIndex ?? -1] ?? null;
  const activeStage = stages[activeStageIndex ?? -1] ?? null;
  const commandSummary = resolveCommandSummary(commandQueue);
  const maxTorqueT = solverMaxTorqueT(solverStatus);

  const relaxReferenceStage =
    activeStage ??
    (selectedStage && isRelaxStageKind(selectedStage.kind) ? selectedStage : null);

  const relaxTorqueStop = resolveRelaxTorqueStop({
    activeStage: relaxReferenceStage,
    activeStageKind: stageExecution?.active_stage_kind ?? null,
    currentTorqueT: maxTorqueT,
  });
  const relaxEnergyStop = resolveRelaxEnergyStop({
    activeStage: relaxReferenceStage,
    activeStageKind: stageExecution?.active_stage_kind ?? null,
    energyHistory: energyHistory ?? null,
  });
  const relaxTimeStop = resolveRelaxTimeStop({
    activeStage: relaxReferenceStage,
    activeStageKind: stageExecution?.active_stage_kind ?? null,
    currentPhysicalTime:
      solverStatus?.sim_time_seconds ?? currentRun?.solver_time_seconds ?? null,
    currentPseudoTime: solverStatus?.pseudo_time_seconds ?? null,
  });

  return {
    boundary: snapshot.boundary,
    requested: snapshot.requested,
    runtime: {
      activeStageLabel: activeStage ? activeStage.label : "No active stage",
      commandBadge: commandSummary.badge,
      commandError: commandSummary.error,
      commandId: commandSummary.commandId,
      commandLabel: commandSummary.label,
      maxTorque: formatTorque(maxTorqueT),
      progressPercent,
      relaxEnergyStop,
      relaxTimeStop,
      relaxTorqueStop,
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

type CommandQueueEntry = CommandQueueStatusResource["commands"][number];

interface CommandSummary {
  badge: string;
  commandId: string | null;
  error: string | null;
  label: string;
}

const ACTIVE_COMMAND_STATUSES = new Set([
  "accepted",
  "dispatched",
  "pending",
  "queued",
  "running",
]);
const PROBLEM_COMMAND_STATUSES = new Set(["failed", "rejected"]);

export function resolveCommandSummary(
  commandQueue: CommandQueueStatusResource | null | undefined,
): CommandSummary {
  if (!commandQueue) {
    return {
      badge: "pending",
      commandId: null,
      error: null,
      label: "Command queue pending",
    };
  }

  const commands = [...commandQueue.commands].reverse();
  const problem = commands.find((command) =>
    PROBLEM_COMMAND_STATUSES.has(command.status),
  );
  if (problem) {
    return commandSummaryFromEntry(problem);
  }

  const active = commands.find((command) =>
    ACTIVE_COMMAND_STATUSES.has(command.status),
  );
  if (active) {
    return commandSummaryFromEntry(active);
  }

  const latest = commands[0] ?? null;
  return latest
    ? commandSummaryFromEntry(latest)
    : {
        badge: "idle",
        commandId: null,
        error: null,
        label: "No queued commands",
      };
}

function commandSummaryFromEntry(command: CommandQueueEntry): CommandSummary {
  return {
    badge: command.status,
    commandId: command.command_id,
    error: command.error ?? null,
    label: `${titleCase(command.kind)} ${command.status}`,
  };
}

function stageSnapshot(value: unknown, index: number): StudyStageSnapshot {
  const stage = asRecord(value);
  const kind = stringValue(stage?.kind ?? stage?.entrypoint_kind, "stage");
  const torqueApm = stageTorqueToleranceApm(stage);
  const rawTorque = torqueApm === null ? null : String(torqueApm);
  const torqueToleranceFormatted =
    torqueApm === null ? null : formatTorquePairFromApm(torqueApm);
  const torqueToleranceShortFormatted =
    torqueApm === null ? null : formatTorqueT(teslaFromApm(torqueApm));
  const hasPseudoTimeBudget =
    stage?.max_pseudotime_s !== undefined &&
    stage?.until_seconds === undefined &&
    stage?.max_physical_time_s === undefined;

  return {
    algorithm: optionalString(stage?.relax_algorithm ?? stage?.algorithm),
    energyTolerance: optionalScalarText(stage?.energy_tolerance),
    index,
    kind,
    maxSteps: optionalScalarText(stage?.max_steps),
    stageId: optionalString(stage?.stage_id ?? stage?.id),
    status: "queued",
    torqueTolerance: rawTorque,
    torqueToleranceFormatted,
    torqueToleranceShortFormatted,
    timeBudgetKind: hasPseudoTimeBudget ? "pseudo" : "physical",
    untilSeconds: optionalScalarText(
      stage?.until_seconds ??
      stage?.max_physical_time_s ??
      stage?.max_pseudotime_s
    ),
  };
}

function stageTorqueToleranceApm(stage: JsonRecord | null): number | null {
  const explicitApm = finiteNumberFromText(
    optionalScalarText(stage?.torque_tolerance_apm),
  );
  if (explicitApm !== null) return explicitApm;

  const legacyApm = finiteNumberFromText(
    optionalScalarText(stage?.torque_tolerance),
  );
  if (legacyApm !== null) return legacyApm;

  const explicitT = finiteNumberFromText(
    optionalScalarText(stage?.torque_tolerance_T),
  );
  return explicitT === null ? null : apmFromTesla(explicitT);
}

function solverMaxTorqueT(
  solverStatus: SolverStatusResource | null,
): number | null {
  const status = solverStatus as
    | (SolverStatusResource & {
        max_torque_Apm?: number | null;
        max_torque_T?: number | null;
      })
    | null;
  const explicitT = finiteNumber(status?.max_torque_T);
  if (explicitT !== null) return explicitT;
  const canonicalApm = finiteNumber(status?.max_torque_Apm);
  return canonicalApm === null ? null : teslaFromApm(canonicalApm);
}

function stageLabel(stage: StudyStageSnapshot): string {
  const base =
    isRelaxStageKind(stage.kind)
      ? "Relax"
      : stage.kind === "run"
        ? "Run"
        : titleCase(stage.kind);
  return `${base} ${stage.index + 1}`;
}

function resolveRelaxTorqueStop({
  activeStage,
  activeStageKind,
  currentTorqueT,
}: {
  activeStage: StudyStageModel | null;
  activeStageKind: string | null;
  currentTorqueT: number | null;
}): StudyRelaxTorqueStopModel | null {
  if (
    !activeStage ||
    (!isRelaxStageKind(activeStage.kind) &&
      !isRelaxStageKind(activeStageKind ?? ""))
  ) {
    return null;
  }

  const thresholdApm = finiteNumberFromText(activeStage.torqueTolerance);
  const thresholdT =
    thresholdApm === null ? null : teslaFromApm(thresholdApm);

  let currentT = finiteNumber(currentTorqueT);
  if (activeStage.status.toLowerCase() === "completed" && activeStage.runtimeMetric?.name === "max_torque_apm") {
    const rawVal = activeStage.runtimeMetric.rawValue;
    if (typeof rawVal === "number") {
      currentT = teslaFromApm(rawVal);
    }
  }

  return {
    current:
      currentT === null ? "unavailable" : formatTorquePairFromTesla(currentT),
    status: formatTorqueStopStatus(currentT, thresholdT),
    threshold:
      thresholdApm === null
        ? "not set"
        : formatTorquePairFromApm(thresholdApm),
  };
}

function resolveRelaxEnergyStop({
  activeStage,
  activeStageKind,
  energyHistory,
}: {
  activeStage: StudyStageModel | null;
  activeStageKind: string | null;
  energyHistory: SolverEnergyHistoryResource | null;
}): StudyRelaxEnergyStopModel | null {
  if (
    !activeStage ||
    (!isRelaxStageKind(activeStage.kind) &&
      !isRelaxStageKind(activeStageKind ?? ""))
  ) {
    return null;
  }

  const thresholdJ = finiteNumberFromText(activeStage.energyTolerance);
  let plateauVal: number | null = null;
  if (activeStage.status.toLowerCase() === "completed" && activeStage.runtimeMetric?.name === "total_energy_plateau_range_J") {
    plateauVal = activeStage.runtimeMetric.rawValue ?? null;
  }

  const rows = energyHistory?.rows ?? [];

  if (plateauVal === null && rows.length < 50) {
    return {
      current: "accumulating steps (need 50)",
      status: "pending history",
      threshold: thresholdJ === null ? "not set" : `${formatScientific(thresholdJ)} J`,
    };
  }

  if (plateauVal === null) {
    const last50 = rows.slice(-50);
    const totals = last50.map((r) => r.total);
    const minE = Math.min(...totals);
    const maxE = Math.max(...totals);
    plateauVal = maxE - minE;
  }

  return {
    current: `${formatScientific(plateauVal)} J`,
    status: formatEnergyStopStatus(plateauVal, thresholdJ),
    threshold: thresholdJ === null ? "not set" : `${formatScientific(thresholdJ)} J`,
  };
}

function formatEnergyStopStatus(
  current: number,
  threshold: number | null,
): string {
  if (threshold === null) return "threshold not set";
  if (current <= threshold) {
    return `${formatThresholdRatio(current, threshold)} of threshold`;
  }
  return `${formatThresholdRatio(current, threshold)} above threshold`;
}

function resolveRelaxTimeStop({
  activeStage,
  activeStageKind,
  currentPhysicalTime,
  currentPseudoTime,
}: {
  activeStage: StudyStageModel | null;
  activeStageKind: string | null;
  currentPhysicalTime: number | null;
  currentPseudoTime: number | null;
}): StudyRelaxTimeStopModel | null {
  if (
    !activeStage ||
    (!isRelaxStageKind(activeStage.kind) &&
      !isRelaxStageKind(activeStageKind ?? ""))
  ) {
    return null;
  }

  let elapsed = finiteNumber(
    activeStage.timeBudgetKind === "pseudo"
      ? currentPseudoTime
      : currentPhysicalTime,
  );
  if (
    activeStage.status.toLowerCase() === "completed" &&
    (activeStage.runtimeMetric?.name === "physical_time_s" ||
      activeStage.runtimeMetric?.name === "pseudotime_s" ||
      activeStage.runtimeMetric?.name === "pseudo_time_s")
  ) {
    elapsed = activeStage.runtimeMetric.rawValue ?? null;
  }

  const budget = finiteNumberFromText(activeStage.untilSeconds);

  return {
    budget: budget === null ? "not set" : `${formatScientific(budget)} s`,
    elapsed: elapsed === null ? "unavailable" : `${formatScientific(elapsed)} s`,
    status: formatTimeStopStatus(elapsed, budget),
  };
}

function formatTimeStopStatus(
  elapsed: number | null,
  budget: number | null,
): string {
  if (budget === null) return "budget not set";
  if (elapsed === null) return "elapsed unavailable";
  if (elapsed <= budget) {
    return `${formatThresholdRatio(elapsed, budget)} of budget`;
  }
  return `${formatThresholdRatio(elapsed, budget)} above budget`;
}

function isRelaxStageKind(kind: string): boolean {
  return kind.toLowerCase().includes("relax");
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

function selectedStageIndexFromNode(
  nodeId: string | null,
  stages: readonly StudyStageSnapshot[],
  stageExecution: StageExecutionResource | null,
): number | null {
  const match = nodeId?.match(/:stage:([^:]+)/);
  if (!match) return null;
  const token = match[1];
  return selectedStageIndexFromId(token, stages, stageExecution);
}

function selectedStageIndexFromId(
  stageId: string | null,
  stages: readonly StudyStageSnapshot[],
  stageExecution: StageExecutionResource | null,
): number | null {
  if (!stageId) return null;
  const index = Number(stageId);
  if (Number.isInteger(index) && index >= 0) return index;
  const snapshotIndex = stages.findIndex((stage) => stage.stageId === stageId);
  if (snapshotIndex >= 0) return snapshotIndex;
  const runtimeIndex = stageExecution?.stages.findIndex(
    (stage) => stage.stage_id === stageId,
  );
  if (runtimeIndex !== undefined && runtimeIndex >= 0) return runtimeIndex;
  return null;
}

function runtimeMetricModel(
  record: StageExecutionResource["stages"][number] | null,
): StudyStageRuntimeMetricModel | null {
  if (!record?.metric_name) return null;
  return {
    name: record.metric_name,
    value: metricValueText(record.metric_name, record.metric_value),
    threshold: metricValueText(record.metric_name, record.threshold),
    rawValue: record.metric_value ?? null,
  };
}

function stageTransitionModel(
  record: StageExecutionResource["stages"][number] | null,
): StudyStageTransitionModel | null {
  const runtimeRecord = record as
    | (StageExecutionResource["stages"][number] & {
        state_transfer_operator_kind?: string | null;
        state_transition?: string | null;
        state_transition_kind?: string | null;
        state_transition_reason?: string | null;
        state_transition_ui_presentation?: string | null;
      })
    | null;
  if (
    !runtimeRecord?.state_transition &&
    !runtimeRecord?.state_transition_kind &&
    !runtimeRecord?.state_transition_reason &&
    !runtimeRecord?.state_transfer_operator_kind &&
    !runtimeRecord?.state_transition_ui_presentation
  ) {
    return null;
  }
  return {
    kind: runtimeRecord.state_transition_kind ?? null,
    label: runtimeRecord.state_transition ?? null,
    reason: runtimeRecord.state_transition_reason ?? null,
    transferOperator: runtimeRecord.state_transfer_operator_kind ?? null,
    uiPresentation: runtimeRecord.state_transition_ui_presentation ?? null,
  };
}

function metricValueText(name: string, value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  if (name === "max_torque_apm") return formatTorquePairFromApm(value);
  if (name === "total_energy_plateau_range_J") return `${formatScientific(value)} J`;
  if (
    name === "physical_time_s" ||
    name === "pseudotime_s" ||
    name === "pseudo_time_s"
  )
    return `${formatScientific(value)} s`;
  if (name === "steps") return String(value);
  return formatScientific(value);
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
    ? formatTorqueT(value)
    : "unavailable";
}

function formatTorqueStopStatus(
  currentT: number | null,
  thresholdT: number | null,
): string {
  if (thresholdT === null) return "threshold not set";
  if (currentT === null) return "current unavailable";
  if (currentT <= thresholdT) {
    return `${formatThresholdRatio(currentT, thresholdT)} of threshold`;
  }
  return `${formatThresholdRatio(currentT, thresholdT)} above threshold`;
}

function formatThresholdRatio(currentT: number, thresholdT: number): string {
  if (thresholdT <= 0) return "n/a";
  const ratio = currentT / thresholdT;
  if (ratio <= 1) return `${(ratio * 100).toPrecision(3)}%`;
  return `${ratio.toPrecision(3)}x`;
}

function titleCase(value: string): string {
  const parts: string[] = [];
  for (const part of value.split(/[_\s-]+/)) {
    if (part) {
      parts.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  return parts.join(" ");
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

function optionalScalarValue(value: unknown, fallback: string): string {
  const text = optionalScalarText(value);
  return text && text.trim().length > 0 ? text : fallback;
}

function booleanLabel(value: unknown, fallback: boolean): string {
  const resolved = typeof value === "boolean" ? value : fallback;
  return resolved ? "enabled" : "disabled";
}

function objectSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "default";
  }
  return Object.keys(value as JsonRecord).length > 0
    ? JSON.stringify(value)
    : "default";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumberFromText(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
