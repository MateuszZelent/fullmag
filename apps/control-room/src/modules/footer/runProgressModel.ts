import type {
  CommandQueueStatusResource,
  CurrentRunResource,
  MeshActiveBuildResource,
  SimulationPreparationResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import {
  meshBuildPhaseStatusIsActive,
  normalizeMeshBuildPhases,
} from "@/shared/domain/mesh/meshBuildPhases";

type StageExecutionRecordResource = StageExecutionResource["stages"][number];

/**
 * Projection of everything the runtime publishes about one simulation run,
 * ordered the way the run executes: preparation, an optional mesh build, then
 * each authored study stage. The view renders it; no value here is inferred
 * beyond the published resources.
 */

export type RunStepState =
  | "pending"
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type RunPhase =
  | "idle"
  | "preparing"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type RunTone = "neutral" | "success" | "warning" | "danger";

export interface RunStepMetric {
  label: string;
  target: string | null;
  value: string;
}

export interface RunStepRow {
  children: RunStepRow[];
  /** Completed duration published by the runtime, when it publishes one. */
  durationMs: number | null;
  endedAtMs: number | null;
  id: string;
  kind: "preparation" | "mesh" | "stage" | "substep";
  message: string | null;
  messageTone: RunTone;
  metric: RunStepMetric | null;
  /** Stage number in the study sequence; null for preparation and mesh. */
  ordinal: number | null;
  percent: number | null;
  progressLabel: string | null;
  startedAtMs: number | null;
  state: RunStepState;
  subtitle: string | null;
  title: string;
}

export interface RunActivityRow {
  atMs: number | null;
  detail: string | null;
  durationMs: number | null;
  id: string;
  /** Stable command identity for browser checks and cross-links. */
  operationId: string | null;
  source: "Command" | "Preparation" | "Mesh";
  status: string | null;
  text: string;
  tone: RunTone;
}

export interface RunProgressModel {
  activity: RunActivityRow[];
  completedStages: number;
  endedAtMs: number | null;
  failure: string | null;
  focus: string | null;
  gaps: string[];
  headline: string;
  overallPercent: number | null;
  phase: RunPhase;
  runId: string | null;
  startedAtMs: number | null;
  steps: RunStepRow[];
  totalStages: number;
}

export interface RunProgressResourceState {
  error?: Error | null;
  label: string;
  status: string;
}

export interface RunProgressInput {
  commandQueue: CommandQueueStatusResource | null;
  currentRun: CurrentRunResource | null;
  meshBuild: MeshActiveBuildResource | null;
  preparation: SimulationPreparationResource | null;
  resources?: readonly RunProgressResourceState[];
  /** Session solver state from the thin status projection. */
  sessionSolverState: string | null;
  stageExecution: StageExecutionResource | null;
}

const ACTIVITY_LIMIT = 120;

const STAGE_KIND_LABELS: Record<string, string> = {
  antenna: "Antenna",
  eigenmodes: "Eigenmodes",
  frequency_response: "Frequency response",
  hysteresis: "Hysteresis",
  relax: "Relaxation",
  relaxation: "Relaxation",
  run: "Time evolution",
  time_evolution: "Time evolution",
};

const METRIC_LABELS: Record<string, string> = {
  max_torque_apm: "Max torque",
  numerical_stagnation: "Stagnation",
  relaxation_time_s: "Relaxation time",
  steps: "Steps",
  total_energy_plateau_range_j: "Energy plateau",
};

const STOP_REASONS: Record<string, { text: string; tone: RunTone }> = {
  backend_error: { text: "Stopped by a backend error", tone: "danger" },
  energy: { text: "Converged: energy plateau reached", tone: "success" },
  gradient: { text: "Converged: gradient tolerance reached", tone: "success" },
  max_physical_time: { text: "Reached the physical time limit", tone: "neutral" },
  max_pseudotime: { text: "Reached the pseudo-time limit without converging", tone: "warning" },
  max_steps: { text: "Reached the step limit without converging", tone: "warning" },
  torque: { text: "Converged: torque tolerance reached", tone: "success" },
  user_cancelled: { text: "Cancelled by user", tone: "warning" },
};

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function normalizeRunStepState(value: unknown): RunStepState {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (token) {
    case "running":
    case "active":
    case "dispatched":
    case "in_progress":
      return "active";
    case "paused":
      return "paused";
    case "completed":
    case "complete":
    case "converged":
    case "done":
    case "succeeded":
    case "success":
    case "ready":
      return "completed";
    case "failed":
    case "error":
    case "rejected":
      return "failed";
    case "cancelled":
    case "canceled":
    case "stopped":
    case "interrupted":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

export function stageKindLabel(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const token = kind.trim().toLowerCase();
  if (!token) return null;
  if (STAGE_KIND_LABELS[token]) return STAGE_KIND_LABELS[token];
  const words = token.replaceAll(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: unknown): number | null {
  const number = finite(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatScientific(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  return magnitude >= 1e-2 && magnitude < 1e4
    ? Number(value.toPrecision(4)).toString()
    : value.toExponential(2);
}

function metricUnit(unit: string | null | undefined): string {
  return unit && unit !== "1" ? ` ${unit}` : "";
}

/** Structured payloads (JSON) belong to dedicated views, not to a progress row. */
function readableDetail(value: unknown): string | null {
  const detail = text(value);
  if (!detail) return null;
  return detail.startsWith("{") || detail.startsWith("[") ? null : detail;
}

function stageMetric(record: StageExecutionRecordResource): RunStepMetric | null {
  const value = finite(record.metric_value);
  if (value === null) return null;
  const label =
    (record.metric_kind ? METRIC_LABELS[record.metric_kind] : null) ??
    text(record.metric_name) ??
    "Metric";
  const unit = metricUnit(record.metric_unit);
  const threshold = finite(record.threshold);
  return {
    label,
    target: threshold === null ? null : `${formatScientific(threshold)}${unit}`,
    value: `${formatScientific(value)}${unit}`,
  };
}

function stageProgressLabel(record: StageExecutionRecordResource): string | null {
  const label = readableDetail(record.progress_label);
  if (label) return label;
  const step = finite(record.completed_step);
  return step === null ? null : `step ${INTEGER.format(step)}`;
}

function stageMessage(
  record: StageExecutionRecordResource,
  state: RunStepState,
  commandErrors: ReadonlyMap<string, string>,
  runFailure: string | null,
): { message: string | null; tone: RunTone } {
  const commandError = record.command_id ? commandErrors.get(record.command_id) : undefined;
  if (state === "failed") {
    return {
      message:
        commandError ??
        (record.reason ? STOP_REASONS[record.reason]?.text : undefined) ??
        runFailure ??
        "Stage failed without a published reason",
      tone: "danger",
    };
  }
  if (record.reason && (state === "completed" || state === "cancelled")) {
    const reason = STOP_REASONS[record.reason];
    if (reason) return { message: reason.text, tone: reason.tone };
  }
  if (state === "active" || state === "paused") {
    return { message: readableDetail(record.progress_detail), tone: "neutral" };
  }
  return { message: null, tone: "neutral" };
}

function buildStageRows(
  execution: StageExecutionResource | null,
  commandErrors: ReadonlyMap<string, string>,
  runFailure: string | null,
): RunStepRow[] {
  if (!execution) return [];
  const byIndex = new Map(execution.stages.map((stage) => [stage.index, stage]));
  const total = Math.max(
    execution.total_stages,
    execution.stages.length,
    execution.stage_statuses.length,
  );
  const completed = new Set(execution.completed_stage_indexes);
  const rows: RunStepRow[] = [];

  for (let index = 0; index < total; index += 1) {
    const record = byIndex.get(index);
    let state = normalizeRunStepState(record?.status ?? execution.stage_statuses[index]);
    if (state === "pending" && completed.has(index)) state = "completed";
    if (!record) {
      rows.push({
        children: [],
        durationMs: null,
        endedAtMs: null,
        id: `stage:${index}`,
        kind: "stage",
        message: null,
        messageTone: "neutral",
        metric: null,
        ordinal: index + 1,
        percent: state === "completed" ? 100 : null,
        progressLabel: null,
        startedAtMs: null,
        state,
        subtitle: index === execution.active_stage_index
          ? stageKindLabel(execution.active_stage_kind)
          : null,
        title: `Stage ${index + 1}`,
      });
      continue;
    }

    const kind = stageKindLabel(record.kind);
    const label = text(record.label);
    const startedAtMs = finite(record.started_at_unix_ms);
    const endedAtMs = finite(record.completed_at_unix_ms);
    const { message, tone } = stageMessage(record, state, commandErrors, runFailure);
    rows.push({
      children: [],
      durationMs: startedAtMs !== null && endedAtMs !== null ? Math.max(0, endedAtMs - startedAtMs) : null,
      endedAtMs,
      id: `stage:${record.stage_id || index}`,
      kind: "stage",
      message,
      messageTone: tone,
      metric: stageMetric(record),
      ordinal: index + 1,
      percent: state === "completed" ? 100 : clampPercent(record.progress_percent),
      progressLabel: stageProgressLabel(record),
      startedAtMs,
      state,
      subtitle: label && kind && label.toLowerCase() !== kind.toLowerCase()
        ? kind
        : text(record.current_settle_step_method),
      title: label ?? kind ?? `Stage ${index + 1}`,
    });
  }
  return rows;
}

function preparationState(status: SimulationPreparationResource["status"]): RunStepState {
  if (status === "ready") return "completed";
  if (status === "failed") return "failed";
  return "active";
}

function executionSummary(
  execution: SimulationPreparationResource["resolved_execution"],
): string | null {
  if (!execution) return null;
  const parts = [
    execution.backend?.toUpperCase(),
    execution.device?.toUpperCase(),
    execution.precision,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(" ") : null;
}

function buildPreparationRow(preparation: SimulationPreparationResource | null): RunStepRow | null {
  if (!preparation) return null;
  const children: RunStepRow[] = preparation.stages
    .filter((stage) => stage.id !== "ready")
    .map((stage) => {
      const state = normalizeRunStepState(stage.status);
      const startedAtMs = finite(stage.started_at_unix_ms);
      const endedAtMs = finite(stage.completed_at_unix_ms);
      return {
        children: [],
        durationMs: finite(stage.duration_ms) ??
          (startedAtMs !== null && endedAtMs !== null ? Math.max(0, endedAtMs - startedAtMs) : null),
        endedAtMs,
        id: `preparation:${stage.id}`,
        kind: "substep" as const,
        message: state === "failed" && preparation.failure?.stage_id === stage.id
          ? preparation.failure.summary
          : null,
        messageTone: state === "failed" ? "danger" as const : "neutral" as const,
        metric: null,
        ordinal: null,
        percent: state === "completed" || state === "skipped" ? 100 : clampPercent(stage.progress_percent),
        progressLabel: text(stage.progress_label),
        startedAtMs,
        state,
        subtitle: state === "active" ? readableDetail(stage.detail) : null,
        title: stage.label,
      };
    });
  const state = preparationState(preparation.status);
  const settled = children.filter((child) => child.state === "completed" || child.state === "skipped").length;
  const active = children.find((child) => child.state === "active");
  const percent = children.length === 0
    ? (state === "completed" ? 100 : null)
    : state === "completed"
      ? 100
      : Math.round(((settled + (active?.percent ?? 0) / 100) / children.length) * 100);
  const startedAtMs = finite(preparation.started_at_unix_ms);
  const endedAtMs = finite(preparation.completed_at_unix_ms);
  const failure = preparation.failure;
  return {
    children,
    durationMs: startedAtMs !== null && endedAtMs !== null ? Math.max(0, endedAtMs - startedAtMs) : null,
    endedAtMs,
    id: `preparation:${preparation.preparation_id}`,
    kind: "preparation",
    message: failure
      ? [failure.summary, failure.detail].filter(Boolean).join(": ")
      : null,
    messageTone: failure ? "danger" : "neutral",
    metric: null,
    ordinal: null,
    percent,
    progressLabel: active ? active.title : `${settled} of ${children.length} steps`,
    startedAtMs,
    state,
    subtitle: executionSummary(preparation.resolved_execution ?? preparation.requested_execution),
    title: "Preparation",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildMeshRow(meshBuild: MeshActiveBuildResource | null): RunStepRow | null {
  if (!meshBuild) return null;
  const active = asRecord(meshBuild.active_build);
  const error = text(meshBuild.last_build_error);
  if (!active && !error) return null;
  const phases = normalizeMeshBuildPhases(meshBuild.mesh_pipeline_status);
  const children: RunStepRow[] = phases.map((phase, index) => {
    const raw = normalizeRunStepState(phase.status);
    const state = raw === "pending" && meshBuildPhaseStatusIsActive(phase, index, phases)
      ? "active"
      : raw;
    return {
      children: [],
      durationMs: phase.durationMs,
      endedAtMs: null,
      id: `mesh:${phase.id}`,
      kind: "substep",
      message: null,
      messageTone: "neutral",
      metric: null,
      ordinal: null,
      percent: state === "completed" || state === "skipped" ? 100 : phase.progressPercent,
      progressLabel: phase.progressLabel,
      startedAtMs: null,
      state,
      subtitle: state === "active" ? readableDetail(phase.detail) : null,
      title: phase.label,
    };
  });
  const settled = children.filter((child) => child.state === "completed" || child.state === "skipped").length;
  const activeChild = children.find((child) => child.state === "active");
  const buildId = text(active?.build_id) ?? text(meshBuild.provenance?.build_id);
  return {
    children,
    durationMs: null,
    endedAtMs: null,
    id: `mesh:${buildId ?? meshBuild.revision}`,
    kind: "mesh",
    message: error,
    messageTone: error ? "danger" : "neutral",
    metric: null,
    ordinal: null,
    percent: children.length > 0
      ? Math.round(((settled + (activeChild?.percent ?? 0) / 100) / children.length) * 100)
      : null,
    progressLabel: activeChild?.title ?? null,
    startedAtMs: null,
    state: active ? "active" : "failed",
    subtitle: buildId,
    title: "Mesh build",
  };
}

function commandTone(state: RunStepState, error: string | null): RunTone {
  if (error || state === "failed") return "danger";
  if (state === "cancelled") return "warning";
  if (state === "completed") return "success";
  return "neutral";
}

function buildActivity(input: RunProgressInput): RunActivityRow[] {
  const rows: RunActivityRow[] = [];
  for (const command of input.commandQueue?.commands ?? []) {
    const state = normalizeRunStepState(command.status);
    const error = text(command.error);
    const startedAt = finite(command.dispatched_at_unix_ms) ?? finite(command.created_at_unix_ms);
    const completedAt = finite(command.completed_at_unix_ms);
    rows.push({
      atMs: finite(command.created_at_unix_ms),
      detail: error ?? text(command.reason) ?? text(command.completion_status),
      durationMs: startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
      id: `command:${command.command_id}`,
      operationId: `command:${command.command_id}`,
      source: "Command",
      status: command.status,
      text: command.kind,
      tone: commandTone(state, error),
    });
  }
  input.preparation?.log_tail.forEach((entry, index) => {
    rows.push({
      atMs: finite(entry.timestamp_unix_ms),
      detail: null,
      durationMs: null,
      id: `preparation-log:${index}:${entry.timestamp_unix_ms}`,
      operationId: null,
      source: "Preparation",
      status: null,
      text: entry.message,
      tone: entry.level === "error" ? "danger" : entry.level === "warning" ? "warning" : "neutral",
    });
  });
  return rows
    .toSorted((left, right) => (right.atMs ?? -Infinity) - (left.atMs ?? -Infinity))
    .slice(0, ACTIVITY_LIMIT);
}

function projectionGaps(resources: readonly RunProgressResourceState[] | undefined): string[] {
  return (resources ?? []).flatMap((resource) => {
    if (resource.status === "error") {
      return [`${resource.label}: ${resource.error?.message ?? "resource load failed"}`];
    }
    if (resource.status === "stale") return [`${resource.label}: showing stale published data`];
    return [];
  });
}

function runPhase(
  input: RunProgressInput,
  preparation: RunStepRow | null,
  stages: readonly RunStepRow[],
): RunPhase {
  if (preparation?.state === "failed") return "failed";
  const runState = normalizeRunStepState(
    input.currentRun?.status ?? input.stageExecution?.runtime_state ?? input.sessionSolverState,
  );
  if (stages.some((stage) => stage.state === "failed") || runState === "failed") return "failed";
  if (preparation?.state === "active" && runState !== "active") return "preparing";
  if (runState === "active" || stages.some((stage) => stage.state === "active")) return "running";
  if (runState === "paused" || stages.some((stage) => stage.state === "paused")) return "paused";
  if (runState === "cancelled") return "cancelled";
  if (stages.length > 0 && stages.every((stage) => stage.state === "completed" || stage.state === "skipped")) {
    return "completed";
  }
  if (runState === "completed") return "completed";
  return "idle";
}

const PHASE_HEADLINES: Record<RunPhase, string> = {
  cancelled: "Stopped",
  completed: "Completed",
  failed: "Failed",
  idle: "Not running",
  paused: "Paused",
  preparing: "Preparing",
  running: "Running",
};

export function buildRunProgressModel(input: RunProgressInput): RunProgressModel {
  const commandErrors = new Map(
    (input.commandQueue?.commands ?? []).flatMap((command) => {
      const error = text(command.error);
      return error ? [[command.command_id, error] as const] : [];
    }),
  );
  const runFailure = normalizeRunStepState(input.currentRun?.status) === "failed"
    ? text(input.currentRun?.status_reason)
    : null;
  const preparation = buildPreparationRow(input.preparation);
  const mesh = buildMeshRow(input.meshBuild);
  const stages = buildStageRows(input.stageExecution, commandErrors, runFailure);
  const phase = runPhase(input, preparation, stages);

  const completedStages = stages.filter((stage) => stage.state === "completed" || stage.state === "skipped").length;
  const activeStage = stages.find((stage) => stage.state === "active" || stage.state === "paused") ??
    stages.find((stage) => stage.state === "failed");
  const overallPercent = phase === "preparing"
    ? preparation?.percent ?? null
    : stages.length > 0
      ? Math.round(((completedStages + (activeStage && activeStage.state !== "failed" ? (activeStage.percent ?? 0) / 100 : 0)) / stages.length) * 100)
      : null;

  let focus: string | null = null;
  if (phase === "preparing") {
    focus = preparation?.progressLabel ?? null;
  } else if (activeStage) {
    focus = `Stage ${activeStage.ordinal} of ${stages.length}: ${activeStage.title}`;
  } else if (stages.length > 0) {
    focus = `${completedStages} of ${stages.length} stages finished`;
  }

  const failure = phase === "failed"
    ? preparation?.state === "failed"
      ? preparation.message
      : stages.find((stage) => stage.state === "failed")?.message ?? runFailure
    : null;

  const startedAtMs = preparation?.startedAtMs ??
    stages.find((stage) => stage.startedAtMs !== null)?.startedAtMs ??
    null;
  const endedAtMs = phase === "completed" || phase === "failed" || phase === "cancelled"
    ? stages.reduce<number | null>(
        (latest, stage) => stage.endedAtMs !== null && (latest === null || stage.endedAtMs > latest) ? stage.endedAtMs : latest,
        preparation?.endedAtMs ?? null,
      )
    : null;

  return {
    activity: buildActivity(input),
    completedStages,
    endedAtMs,
    failure,
    focus,
    gaps: projectionGaps(input.resources),
    headline: PHASE_HEADLINES[phase],
    overallPercent,
    phase,
    runId: input.currentRun?.run_id ?? input.stageExecution?.run_id ?? null,
    startedAtMs,
    steps: [preparation, mesh, ...stages].filter((row): row is RunStepRow => row !== null),
    totalStages: stages.length,
  };
}

/** Wall-clock span of a step at `nowMs`; null when the runtime published no start. */
export function runStepElapsedMs(step: RunStepRow, nowMs: number | null): number | null {
  if (step.durationMs !== null) return step.durationMs;
  if (step.startedAtMs === null) return null;
  const end = step.endedAtMs ?? (step.state === "active" ? nowMs : null);
  return end === null ? null : Math.max(0, end - step.startedAtMs);
}

/**
 * Linear remaining-time estimate from published percent and elapsed time.
 * Returns null until enough progress exists for the estimate to mean anything.
 */
export function estimateRemainingMs(percent: number | null, elapsedMs: number | null): number | null {
  if (percent === null || elapsedMs === null || percent < 3 || percent >= 100) return null;
  return (elapsedMs * (100 - percent)) / percent;
}

export function formatRunDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)} s`;
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatClockTime(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}
