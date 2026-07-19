import type {
  LiveStatusResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import type { ResourceResult } from "../resources/resourceTypes";

const MAX_PREPARATION_LOG_ENTRIES = 200;
const BOOTSTRAPPING_STATUSES = new Set(["bootstrapping"]);
const MATERIALIZING_STATUSES = new Set(["materializing_script"]);

type PreparationStage = SimulationPreparationResource["stages"][number];
type PreparationLogEntry = SimulationPreparationResource["log_tail"][number];

export interface SimulationPreparationStageView {
  readonly detail: string;
  readonly elapsedLabel: string;
  readonly id: PreparationStage["id"];
  readonly isActive: boolean;
  readonly label: string;
  readonly progressLabel: string | null;
  readonly stateLabel: string;
  readonly status: PreparationStage["status"];
}

export interface SimulationPreparationLogEntryView {
  readonly level: PreparationLogEntry["level"];
  readonly message: string;
  readonly stageLabel: string;
  readonly timestampLabel: string;
}

export interface SimulationPreparationFailureView {
  readonly correlationId: string | null;
  readonly errorCode: string;
  readonly stageLabel: string;
  readonly summary: string;
}

export type SimulationPreparationProgressView =
  | { readonly kind: "determinate"; readonly value: number }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "terminal" };

export interface SimulationPreparationViewModel {
  readonly activeStage: SimulationPreparationStageView | null;
  readonly detail: string;
  readonly eyebrow: "Simulation preparation";
  readonly failure: SimulationPreparationFailureView | null;
  readonly isTerminal: boolean;
  readonly isVisible: boolean;
  readonly kind:
    | "connecting"
    | "failed"
    | "hidden"
    | "ready"
    | "resource-error"
    | "running"
    | "stale";
  readonly liveSummary: string;
  readonly logEntries: readonly SimulationPreparationLogEntryView[];
  readonly preparation: SimulationPreparationResource | null;
  readonly progress: SimulationPreparationProgressView;
  readonly progressLabel: string | null;
  readonly reconnectingMessage: string | null;
  readonly reconnectingTitle: string | null;
  readonly requestedExecutionLabel: string | null;
  readonly resolvedExecutionLabel: string | null;
  readonly stages: readonly SimulationPreparationStageView[];
  readonly title: string;
  readonly totalElapsedLabel: string | null;
}

export function resolveSimulationPreparationViewModel(
  preparation: ResourceResult<SimulationPreparationResource>,
  sessionStatus: ResourceResult<LiveStatusResource>,
  nowUnixMs: number | null,
): SimulationPreparationViewModel {
  const snapshot = preparation.data;
  if (!snapshot) {
    return resolveMissingPreparationModel(preparation, sessionStatus);
  }

  const stages = snapshot.stages.map((stage) =>
    resolveStageView(stage, nowUnixMs),
  );
  const activeStage =
    stages.find((stage) => stage.id === snapshot.active_stage_id) ??
    stages.find((stage) => stage.status === "active") ??
    null;
  const stageLabels = new Map(stages.map((stage) => [stage.id, stage.label]));
  const progress = resolveProgress(activeStage, snapshot);
  const isStale = preparation.status === "stale";
  const isFailed = snapshot.status === "failed";
  const isReady = snapshot.status === "ready";
  const failure = snapshot.failure
    ? {
        correlationId: snapshot.failure.diagnostics_correlation_id ?? null,
        errorCode: snapshot.failure.error_code,
        stageLabel:
          stageLabels.get(snapshot.failure.stage_id) ?? snapshot.failure.stage_id,
        summary: snapshot.failure.summary,
      }
    : null;
  const kind = isStale
    ? "stale"
    : isFailed
      ? "failed"
      : isReady
        ? "ready"
        : snapshot.status === "connecting"
          ? "connecting"
          : "running";
  const title = isFailed
    ? "Simulation preparation failed"
    : isReady
      ? "Simulation ready"
      : activeStage?.label ?? "Preparing simulation";
  const detail = isFailed
    ? failure?.summary ?? "Simulation preparation failed."
    : isReady
      ? "Solver initialization completed."
      : activeStage?.detail || "Preparing the runtime workspace.";
  const logEntries = snapshot.log_tail
    .slice(-MAX_PREPARATION_LOG_ENTRIES)
    .map((entry) => ({
      level: entry.level,
      message: entry.message,
      stageLabel: stageLabels.get(entry.stage_id) ?? entry.stage_id,
      timestampLabel: formatLogTimestamp(entry.timestamp_unix_ms),
    }));
  const totalElapsedLabel = resolveTotalElapsedLabel(snapshot, nowUnixMs);

  return {
    activeStage,
    detail,
    eyebrow: "Simulation preparation",
    failure,
    isTerminal: isFailed || isReady,
    isVisible: !isReady || isStale,
    kind,
    liveSummary: resolveLiveSummary({
      activeStage,
      failure,
      isStale,
      title,
    }),
    logEntries,
    preparation: snapshot,
    progress,
    progressLabel:
      progress.kind === "terminal" ? null : activeStage?.progressLabel ?? null,
    reconnectingMessage: isStale
      ? "Displayed progress may be out of date."
      : null,
    reconnectingTitle: isStale ? "Reconnecting…" : null,
    requestedExecutionLabel: formatExecutionSummary(snapshot.requested_execution),
    resolvedExecutionLabel: formatExecutionSummary(snapshot.resolved_execution),
    stages,
    title,
    totalElapsedLabel,
  };
}

function resolveMissingPreparationModel(
  preparation: ResourceResult<SimulationPreparationResource>,
  sessionStatus: ResourceResult<LiveStatusResource>,
): SimulationPreparationViewModel {
  const solverState = sessionStatus.data?.solver.state?.toLowerCase() ?? "";
  const isMaterializing = MATERIALIZING_STATUSES.has(solverState);
  const isBootstrapping = BOOTSTRAPPING_STATUSES.has(solverState);
  const preparationRevision =
    sessionStatus.data?.resources.simulation_preparation_revision;
  const hasPublishedPreparationRevision =
    typeof preparationRevision === "number" && preparationRevision > 0;
  const preparationError = resolvePreparationResourceError(
    preparation,
    hasPublishedPreparationRevision,
  );
  if (preparationError) {
    return preparationError;
  }
  const hasNonTransientSessionError =
    sessionStatus.status === "error" &&
    !isTransientStartupError(sessionStatus.error);
  const isConnecting =
    !hasNonTransientSessionError &&
    (sessionStatus.status === "idle" ||
      sessionStatus.status === "loading" ||
      isBootstrapping ||
      isMaterializing ||
      hasPublishedPreparationRevision ||
      ((preparation.status === "idle" || preparation.status === "loading") &&
        sessionStatus.data === null) ||
      (sessionStatus.status === "error" &&
        isTransientStartupError(sessionStatus.error)));
  const title = isMaterializing ? "Compiling simulation" : "Preparing simulation";
  const detail = isMaterializing
    ? "Compiling the model and preparing runtime data."
    : isBootstrapping
      ? "Starting the runtime workspace."
      : sessionStatus.status === "error"
        ? "Waiting for the runtime workspace to become available."
        : "Connecting to the local simulation backend.";

  return {
    activeStage: null,
    detail,
    eyebrow: "Simulation preparation",
    failure: null,
    isTerminal: false,
    isVisible: isConnecting,
    kind: isConnecting ? "connecting" : "hidden",
    liveSummary: `${title}. ${detail}`,
    logEntries: [],
    preparation: null,
    progress: { kind: "indeterminate" },
    progressLabel: null,
    reconnectingMessage: null,
    reconnectingTitle: null,
    requestedExecutionLabel: null,
    resolvedExecutionLabel: null,
    stages: [],
    title,
    totalElapsedLabel: null,
  };
}

function resolvePreparationResourceError(
  preparation: ResourceResult<SimulationPreparationResource>,
  hasPublishedPreparationRevision: boolean,
): SimulationPreparationViewModel | null {
  if (preparation.status !== "error" || !preparation.error) {
    return null;
  }

  const status = errorStatus(preparation.error);
  if (
    isTransientStartupError(preparation.error) ||
    (status === 404 && !hasPublishedPreparationRevision)
  ) {
    return null;
  }

  const message = preparation.error.message.toLowerCase();
  const detail =
    status === 401 || status === 403
      ? "Authorization is required to read simulation preparation status."
      : message.includes("contract version mismatch")
        ? "The Control Room API contract is incompatible. Restart or update the local runtime."
        : "The local runtime could not provide simulation preparation status. Open diagnostics or retry.";

  return {
    activeStage: null,
    detail,
    eyebrow: "Simulation preparation",
    failure: null,
    isTerminal: true,
    isVisible: true,
    kind: "resource-error",
    liveSummary: `Preparation status unavailable. ${detail}`,
    logEntries: [],
    preparation: null,
    progress: { kind: "terminal" },
    progressLabel: null,
    reconnectingMessage: null,
    reconnectingTitle: null,
    requestedExecutionLabel: null,
    resolvedExecutionLabel: null,
    stages: [],
    title: "Preparation status unavailable",
    totalElapsedLabel: null,
  };
}

function errorStatus(error: Error): number | null {
  if (!("status" in error)) return null;
  const status = (error as Error & { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

function resolveStageView(
  stage: PreparationStage,
  nowUnixMs: number | null,
): SimulationPreparationStageView {
  const durationMs = resolveStageDurationMs(stage, nowUnixMs);
  return {
    detail: stage.detail,
    elapsedLabel:
      stage.status === "skipped"
        ? "Skipped"
        : durationMs === null
          ? "—"
          : formatDuration(durationMs),
    id: stage.id,
    isActive: stage.status === "active",
    label: stage.label,
    progressLabel: stage.progress_label ?? null,
    stateLabel: formatStageState(stage.status),
    status: stage.status,
  };
}

function resolveStageDurationMs(
  stage: PreparationStage,
  nowUnixMs: number | null,
): number | null {
  const backendDuration = normalizeDuration(stage.duration_ms);
  if (
    stage.status === "active" &&
    nowUnixMs !== null &&
    typeof stage.started_at_unix_ms === "number"
  ) {
    return Math.max(backendDuration ?? 0, nowUnixMs - stage.started_at_unix_ms);
  }
  if (
    backendDuration === null &&
    typeof stage.started_at_unix_ms === "number" &&
    typeof stage.completed_at_unix_ms === "number"
  ) {
    return Math.max(0, stage.completed_at_unix_ms - stage.started_at_unix_ms);
  }
  return backendDuration;
}

function resolveProgress(
  activeStage: SimulationPreparationStageView | null,
  snapshot: SimulationPreparationResource,
): SimulationPreparationProgressView {
  if (snapshot.status === "failed") {
    return { kind: "terminal" };
  }
  const source = snapshot.stages.find((stage) => stage.id === activeStage?.id);
  const value = source?.progress_percent;
  return typeof value === "number" && value >= 0 && value <= 100
    ? { kind: "determinate", value }
    : { kind: "indeterminate" };
}

function resolveTotalElapsedLabel(
  snapshot: SimulationPreparationResource,
  nowUnixMs: number | null,
): string | null {
  const endpoint = snapshot.completed_at_unix_ms ?? nowUnixMs;
  if (endpoint === null) return null;
  return formatDuration(Math.max(0, endpoint - snapshot.started_at_unix_ms));
}

function resolveLiveSummary({
  activeStage,
  failure,
  isStale,
  title,
}: {
  activeStage: SimulationPreparationStageView | null;
  failure: SimulationPreparationFailureView | null;
  isStale: boolean;
  title: string;
}): string {
  if (isStale) {
    return "Reconnecting. Displayed progress may be out of date.";
  }
  if (failure) {
    return `${title}. ${failure.summary}`;
  }
  return activeStage
    ? `${activeStage.label} ${activeStage.stateLabel.toLowerCase()}.`
    : `${title}.`;
}

function formatExecutionSummary(
  summary: SimulationPreparationResource["resolved_execution"],
): string | null {
  if (!summary) return null;
  const values = [
    summary.backend,
    summary.device,
    summary.precision,
    summary.mode,
    summary.engine_id,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : null;
}

function formatStageState(status: PreparationStage["status"]): string {
  return `${status[0]?.toUpperCase() ?? ""}${status.slice(1)}`;
}

function normalizeDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatLogTimestamp(timestampUnixMs: number): string {
  return new Date(timestampUnixMs).toISOString().slice(11, 23);
}

function isTransientStartupError(error: Error | null): boolean {
  const message = error?.message.toLowerCase() ?? "";
  return (
    message.includes("no active local live workspace") ||
    message.includes("no active workspace") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("connection refused")
  );
}

export { serializeSimulationPreparationDiagnostics } from "./simulationPreparationDiagnostics";
