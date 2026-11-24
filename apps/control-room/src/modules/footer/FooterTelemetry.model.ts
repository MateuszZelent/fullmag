import type { LiveStatusResource, ScalarWindowResource, SceneResource, SolverStatusResource, StageExecutionResource } from "@/kernel/api/apiTypes";
import { hasEmptyObjectMagneticModel } from "@/shared/domain/physics/objectMagneticModel";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { isRuntimeStateActive } from "@/kernel/runtime/runtimeStateDisplay";

type FooterScalarResourceSample = {
  revision: number;
  row: Record<string, number>;
  series: ScalarWindowResource["series"];
  runId: string;
  sessionId: string;
};

export type FooterMeanTimestep = {
  attemptId: string;
  firstStep: number;
  lastStep: number;
  secondsPerStep: number;
  stepCount: number;
};

export type FooterScalarAttemptReference = Pick<
  NonNullable<ScalarWindowResource["series"]>,
  "run_id" | "task_id" | "step_id" | "attempt_id" | "ownership_epoch"
>;

export type FooterRelaxationAlgorithm = NonNullable<
  LiveStatusResource["solver"]["relaxation_algorithm"]
>;

const FOOTER_RELAXATION_ALGORITHMS = new Set<FooterRelaxationAlgorithm>([
  "llg_overdamped",
  "projected_gradient_bb",
  "nonlinear_cg",
  "tangent_plane_implicit",
]);

export type FooterTelemetryStatus = {
  energies: Pick<
    LiveStatusResource["energies"],
    "anisotropy" | "demag" | "dmi" | "exchange" | "total" | "zeeman"
  > | null;
  metrics: Pick<
    LiveStatusResource["metrics"],
    "steps_per_second" | "total_steps"
  >;
  run: Pick<
    NonNullable<LiveStatusResource["run"]>,
    | "calibration_id"
    | "requested_device"
    | "resolved_device"
    | "run_id"
    | "selection_confidence"
    | "selection_reason"
    | "stage_count"
    | "stage_index"
    | "stage_label"
    | "solver_steps"
    | "solver_time"
  > | null;
  sessionId: string;
  sessionEpoch: string;
  requestScopeEpoch: string;
  scalarsRevision: number;
  solver: Pick<
    LiveStatusResource["solver"],
    | "algorithm"
    | "converged"
    | "dt"
    | "max_torque_T"
    | "relaxation_algorithm"
    | "state"
  >;
};

export function selectFooterTelemetryStatus(
  sessionStatus: ResourceResult<LiveStatusResource>,
): FooterTelemetryStatus | null {
  const data = sessionStatus.data;
  if (!data) return null;

  return {
    energies: data.energies
      ? {
          anisotropy: data.energies.anisotropy ?? null,
          demag: data.energies.demag ?? null,
          dmi: data.energies.dmi ?? null,
          exchange: data.energies.exchange ?? null,
          total: data.energies.total ?? null,
          zeeman: data.energies.zeeman ?? null,
        }
      : null,
    metrics: {
      steps_per_second: data.metrics.steps_per_second ?? null,
      total_steps: data.metrics.total_steps,
    },
    run: data.run
      ? {
          calibration_id: data.run.calibration_id ?? null,
          requested_device: data.run.requested_device,
          resolved_device: data.run.resolved_device,
          run_id: data.run.run_id,
          selection_confidence: data.run.selection_confidence ?? null,
          selection_reason: data.run.selection_reason,
          stage_count: data.run.stage_count,
          stage_index: data.run.stage_index,
          stage_label: data.run.stage_label,
          solver_steps: data.run.solver_steps,
          solver_time: data.run.solver_time,
        }
      : null,
    sessionId: data.session.session_id,
    sessionEpoch: data.session.session_epoch,
    requestScopeEpoch: data.session.request_scope_epoch,
    scalarsRevision: data.resources.scalars_revision,
    solver: {
      algorithm: data.solver.algorithm ?? null,
      converged: data.solver.converged ?? null,
      dt: data.solver.dt ?? null,
      max_torque_T: data.solver.max_torque_T ?? null,
      relaxation_algorithm: data.solver.relaxation_algorithm ?? null,
      state: data.solver.state,
    },
  };
}

export function footerTelemetryStatusEquals(
  previous: FooterTelemetryStatus | null,
  next: FooterTelemetryStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;

  return (
    Object.is(previous.metrics.steps_per_second, next.metrics.steps_per_second) &&
    Object.is(previous.metrics.total_steps, next.metrics.total_steps) &&
    Object.is(previous.sessionId, next.sessionId) &&
    Object.is(previous.sessionEpoch, next.sessionEpoch) &&
    Object.is(previous.requestScopeEpoch, next.requestScopeEpoch) &&
    Object.is(previous.scalarsRevision, next.scalarsRevision) &&
    Object.is(previous.run?.run_id ?? null, next.run?.run_id ?? null) &&
    Object.is(
      previous.run?.requested_device ?? null,
      next.run?.requested_device ?? null,
    ) &&
    Object.is(
      previous.run?.resolved_device ?? null,
      next.run?.resolved_device ?? null,
    ) &&
    Object.is(
      previous.run?.selection_reason ?? null,
      next.run?.selection_reason ?? null,
    ) &&
    Object.is(
      previous.run?.calibration_id ?? null,
      next.run?.calibration_id ?? null,
    ) &&
    Object.is(
      previous.run?.selection_confidence ?? null,
      next.run?.selection_confidence ?? null,
    ) &&
    Object.is(previous.run?.stage_count ?? null, next.run?.stage_count ?? null) &&
    Object.is(previous.run?.stage_index ?? null, next.run?.stage_index ?? null) &&
    Object.is(previous.run?.stage_label ?? null, next.run?.stage_label ?? null) &&
    Object.is(
      previous.run?.solver_steps ?? null,
      next.run?.solver_steps ?? null,
    ) &&
    Object.is(
      previous.run?.solver_time ?? null,
      next.run?.solver_time ?? null,
    ) &&
    Object.is(previous.solver.algorithm, next.solver.algorithm) &&
    Object.is(previous.solver.relaxation_algorithm, next.solver.relaxation_algorithm) &&
    Object.is(previous.solver.converged, next.solver.converged) &&
    Object.is(previous.solver.dt, next.solver.dt) &&
    Object.is(previous.solver.max_torque_T, next.solver.max_torque_T) &&
    Object.is(previous.solver.state, next.solver.state) &&
    Object.is(
      previous.energies?.anisotropy ?? null,
      next.energies?.anisotropy ?? null,
    ) &&
    Object.is(
      previous.energies?.demag ?? null,
      next.energies?.demag ?? null,
    ) &&
    Object.is(previous.energies?.dmi ?? null, next.energies?.dmi ?? null) &&
    Object.is(
      previous.energies?.exchange ?? null,
      next.energies?.exchange ?? null,
    ) &&
    Object.is(
      previous.energies?.total ?? null,
      next.energies?.total ?? null,
    ) &&
    Object.is(
      previous.energies?.zeeman ?? null,
      next.energies?.zeeman ?? null,
    )
  );
}

export type FooterAntennaStage = {
  active: boolean;
  identityKey: string;
  clockKey: string | null;
  record: StageExecutionResource["stages"][number];
};

export type FooterEigensolveStage = {
  active: boolean;
  identityKey: string;
  clockKey: string | null;
  kind: string;
  record: StageExecutionResource["stages"][number];
};

const FOOTER_EIGENSOLVE_STAGE_KINDS = new Set([
  "eigenmodes",
  "flat_eigenmodes",
  "frequency_response",
  "flat_frequency_response",
]);

export function resolveFooterEigensolveStage(
  status: FooterTelemetryStatus | null | undefined,
  execution: StageExecutionResource | null | undefined,
): FooterEigensolveStage | null {
  if (
    !status?.sessionId ||
    !status.sessionEpoch ||
    !status.requestScopeEpoch ||
    !status.run?.run_id ||
    !execution ||
    execution.session_id !== status.sessionId ||
    execution.session_epoch !== status.sessionEpoch ||
    execution.request_scope_epoch !== status.requestScopeEpoch ||
    execution.run_id !== status.run.run_id
  ) {
    return null;
  }

  const activeIndex = execution.active_stage_index;
  const activeCandidate =
    typeof activeIndex === "number" &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0
      ? execution.stages[activeIndex] ?? null
      : null;
  const fallbackCandidate =
    activeCandidate &&
    FOOTER_EIGENSOLVE_STAGE_KINDS.has((activeCandidate.kind ?? "").toLowerCase())
      ? activeCandidate
      : [...execution.stages]
          .reverse()
          .find((stage) =>
            FOOTER_EIGENSOLVE_STAGE_KINDS.has((stage.kind ?? "").toLowerCase()),
          ) ?? null;

  const record = fallbackCandidate;
  if (
    !record ||
    !record.stage_id?.trim() ||
    !record.kind?.trim() ||
    !FOOTER_EIGENSOLVE_STAGE_KINDS.has(record.kind.toLowerCase()) ||
    !["pending", "running", "completed", "failed", "cancelled"].includes(
      record.status,
    )
  ) {
    return null;
  }

  const active =
    record.status === "running" && execution.runtime_state === "running";
  const clockKey =
    active && validStageTimestamp(record.started_at_unix_ms)
      ? JSON.stringify([
          execution.session_id,
          execution.session_epoch,
          execution.request_scope_epoch,
          execution.run_id,
          record.stage_id,
          record.kind,
          record.started_at_unix_ms,
        ])
      : null;

  return {
    active,
    clockKey,
    identityKey: JSON.stringify([
      execution.session_id,
      execution.session_epoch,
      execution.request_scope_epoch,
      execution.run_id,
      record.stage_id,
      record.kind,
      record.index,
    ]),
    kind: record.kind.toLowerCase(),
    record,
  };
}

export function resolveFooterAntennaStage(
  status: FooterTelemetryStatus | null | undefined,
  execution: StageExecutionResource | null | undefined,
): FooterAntennaStage | null {
  if (!status?.sessionId || !status.sessionEpoch || !status.requestScopeEpoch ||
    !status.run?.run_id || !execution ||
    execution.session_id !== status.sessionId ||
    execution.session_epoch !== status.sessionEpoch ||
    execution.request_scope_epoch !== status.requestScopeEpoch ||
    execution.run_id !== status.run.run_id) return null;

  // Accepted terminal/pending runs have no active index. Only a single-stage
  // run is unambiguous in that case; never guess a multi-stage run's physics.
  const index = execution.active_stage_index ?? (execution.stages.length === 1 ? 0 : null);
  if (index === null || !Number.isInteger(index) || index < 0) return null;
  const record = execution.stages[index];
  if (!record || record.index !== index || !record.stage_id?.trim() ||
    !record.antenna_solve_stage_id?.trim() ||
    !["pending", "running", "completed", "failed", "cancelled"].includes(record.status)) return null;

  const clockKey = record.status === "running" && execution.runtime_state === "running" &&
    validStageTimestamp(record.started_at_unix_ms)
    ? JSON.stringify([execution.session_id, execution.session_epoch,
      execution.request_scope_epoch, execution.run_id, record.stage_id,
      record.antenna_solve_stage_id, record.started_at_unix_ms])
    : null;
  return {
    active: record.status === "running" && execution.runtime_state === "running",
    identityKey: JSON.stringify([execution.session_id, execution.session_epoch,
      execution.request_scope_epoch, execution.run_id, record.stage_id, record.antenna_solve_stage_id, record.index]),
    clockKey, record,
  };
}

export function validStageTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function resolveFooterScalarResourceSample(
  status: FooterTelemetryStatus | null | undefined,
  window: ScalarWindowResource | null | undefined,
): FooterScalarResourceSample | null {
  const source = window?.current_observation;
  const values = window?.rows[0];
  if (!status?.sessionId || !status.run?.run_id || !window || !source || !values ||
      window.rows.length !== 1 || window.returned_rows !== 1 ||
      source.session_id !== status.sessionId || source.run_id !== status.run.run_id ||
      source.request_scope_epoch !== status.requestScopeEpoch ||
      (window.series !== null && window.series !== undefined &&
        window.series.run_id !== source.run_id) ||
      !Number.isSafeInteger(window.revision) || window.revision < 0 ||
      source.scalar_revision !== window.revision ||
      !Number.isSafeInteger(source.source_step) || source.source_step < 0 ||
      values.length !== window.columns.length) return null;
  const row: Record<string, number> = {};
  for (const [index, column] of window.columns.entries()) {
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value)) row[column] = value;
  }
  if (row.step !== source.source_step || scalarSampleMagnetization(row) === null) return null;
  return {
    revision: window.revision,
    row,
    series: window.series ?? null,
    runId: source.run_id,
    sessionId: source.session_id,
  };
}

/**
 * Mean physical or pseudotime step over the latest two valid samples in one
 * accepted scalar attempt. This is deliberately a span average, never a claim
 * about the most recent solver step.
 */
export function resolveFooterMeanTimestep(
  status: FooterTelemetryStatus | null | undefined,
  window: ScalarWindowResource | null | undefined,
  clockColumn: "time" | "pseudo_time_s" = "time",
  expectedAttempt?: FooterScalarAttemptReference | null,
  expectedStageId?: string | null,
): FooterMeanTimestep | null {
  const series = window?.series;
  if (
    !status?.run?.run_id || !status.sessionEpoch || !window || !series ||
    series.run_id !== status.run.run_id || !hasFooterText(series.task_id) ||
    !hasFooterText(series.step_id) || !hasFooterText(series.case_id) ||
    !hasFooterText(series.attempt_id) || !Number.isSafeInteger(series.ownership_epoch) ||
    series.ownership_epoch < 0 || window.rows.length < 2 ||
    (expectedStageId !== null && expectedStageId !== undefined &&
      series.step_id !== expectedStageId) ||
    (expectedAttempt !== null && expectedAttempt !== undefined &&
      !sameFooterScalarAttempt(series, expectedAttempt)) ||
    window.returned_rows !== window.rows.length ||
    window.observation_frames.length !== window.rows.length
  ) {
    return null;
  }

  const stepColumn = window.columns.indexOf("step");
  const timeColumn = window.columns.indexOf("time");
  const clockColumnIndex = window.columns.indexOf(clockColumn);
  if (stepColumn < 0 || timeColumn < 0 || clockColumnIndex < 0) return null;

  const samplesByStep = new Map<number, { clockSeconds: number }>();
  for (const [index, row] of window.rows.entries()) {
    const frame = window.observation_frames[index];
    const step = row[stepColumn];
    const physicalTime = row[timeColumn];
    const clockSeconds = row[clockColumnIndex];
    if (
      !frame || frame.session_epoch !== status.sessionEpoch ||
      !Number.isSafeInteger(step) || step < 0 || frame.source_step !== step ||
      typeof physicalTime !== "number" || !Number.isFinite(physicalTime) ||
      typeof frame.source_time_seconds !== "number" ||
      frame.source_time_seconds !== physicalTime ||
      typeof clockSeconds !== "number" || !Number.isFinite(clockSeconds)
    ) {
      continue;
    }
    samplesByStep.set(step, { clockSeconds });
  }

  const samples = [...samplesByStep.entries()].toSorted(([left], [right]) => left - right);
  if (samples.length < 2) return null;
  const [first, last] = samples.slice(-2);
  if (!first || !last) return null;
  const [firstStep, firstSample] = first;
  const [lastStep, lastSample] = last;
  const stepCount = lastStep - firstStep;
  const timeDelta = lastSample.clockSeconds - firstSample.clockSeconds;
  if (stepCount <= 0 || timeDelta <= 0 || !Number.isFinite(timeDelta)) return null;
  const secondsPerStep = timeDelta / stepCount;
  if (!Number.isFinite(secondsPerStep) || secondsPerStep <= 0) return null;

  return {
    attemptId: series.attempt_id,
    firstStep,
    lastStep,
    secondsPerStep,
    stepCount,
  };
}

function sameFooterScalarAttempt(
  series: NonNullable<ScalarWindowResource["series"]>,
  expected: FooterScalarAttemptReference,
): boolean {
  return series.run_id === expected.run_id &&
    series.task_id === expected.task_id &&
    series.step_id === expected.step_id &&
    series.attempt_id === expected.attempt_id &&
    series.ownership_epoch === expected.ownership_epoch;
}

function hasFooterText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveFooterSolverStatus(
  status: FooterTelemetryStatus | null | undefined,
  solverStatus: SolverStatusResource | null | undefined,
): SolverStatusResource | null {
  if (!status?.run?.run_id || solverStatus?.run_id !== status.run.run_id) {
    return null;
  }
  return solverStatus;
}

export function resolveFooterRuntimeRelaxationAlgorithm(
  status: FooterTelemetryStatus | null | undefined,
  solverStatus?: SolverStatusResource | null,
  stageExecution?: StageExecutionResource | null,
): FooterRelaxationAlgorithm | null {
  if (!status?.run?.run_id) return null;
  const currentSolverStatus = resolveFooterSolverStatus(status, solverStatus);
  const currentStageMethod = resolveFooterActiveStageMethod(status, stageExecution);
  const stageAlgorithm = normalizeFooterStageMethod(currentStageMethod);
  if (stageAlgorithm) return stageAlgorithm;
  const candidates = [
    currentSolverStatus?.relaxation_algorithm,
    status.solver.relaxation_algorithm,
    currentSolverStatus?.algorithm,
    status.solver.algorithm,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeFooterRelaxationAlgorithm(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export function resolveFooterActiveStageMethod(
  status: FooterTelemetryStatus,
  stageExecution: StageExecutionResource | null | undefined,
): string | null {
  if (
    !stageExecution ||
    stageExecution.session_id !== status.sessionId ||
    stageExecution.session_epoch !== status.sessionEpoch ||
    stageExecution.request_scope_epoch !== status.requestScopeEpoch ||
    stageExecution.run_id !== status.run?.run_id ||
    !isRuntimeStateActive(stageExecution.runtime_state) ||
    !Number.isSafeInteger(stageExecution.active_stage_index)
  ) {
    return null;
  }
  const activeStage = stageExecution.stages.find(
    (stage) => stage.index === stageExecution.active_stage_index,
  );
  if (
    !activeStage ||
    !["active", "running"].includes(activeStage.status.trim().toLowerCase())
  ) {
    return null;
  }
  return activeStage.current_settle_step_method ?? null;
}

function normalizeFooterRelaxationAlgorithm(
  value: unknown,
): FooterRelaxationAlgorithm | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return FOOTER_RELAXATION_ALGORITHMS.has(normalized as FooterRelaxationAlgorithm)
    ? normalized as FooterRelaxationAlgorithm
    : null;
}

function normalizeFooterStageMethod(value: string | null): FooterRelaxationAlgorithm | null {
  if (isFooterLlgRuntimeStageMethod(value)) return "llg_overdamped";
  return normalizeFooterRelaxationAlgorithm(value);
}

export function isFooterLlgRuntimeStageMethod(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "llg_overdamped" || normalized === "heun_dynamics_settle";
}

export function resolveFooterMagneticModelPresent(
  scene: Pick<ResourceResult<SceneResource>, "data" | "status">,
): boolean | null {
  if ((scene.status !== "ready" && scene.status !== "stale") || !Array.isArray(scene.data?.objects)) return null;
  return !scene.data.objects.every(hasEmptyObjectMagneticModel);
}

export function resolvePrimaryTelemetryObjectId(
  scene: SceneResource | null | undefined,
  selectedObjectId?: string | null,
): string | null {
  const objects = scene?.objects ?? [];
  const selected = objects.find((object) => object.id === selectedObjectId);
  // An explicitly selected empty model must not borrow another object's metrics.
  if (selected) return hasEmptyObjectMagneticModel(selected) ? null : selected.id;
  return objects.find((object) => !hasEmptyObjectMagneticModel(object))?.id ?? null;
}

export function scalarSampleNumber(
  row: Record<string, number> | null,
  key: string,
): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function scalarSampleMagnetization(
  row: Record<string, number> | null,
): { mx: number; my: number; mz: number } | null {
  const mx = scalarSampleNumber(row, "mx");
  const my = scalarSampleNumber(row, "my");
  const mz = scalarSampleNumber(row, "mz");
  if (mx === null || my === null || mz === null) return null;
  return { mx, my, mz };
}
