import type { RunPerformanceResource, ScalarWindowResource } from "@/kernel/api/apiTypes";

const OBSERVED_PERFORMANCE_STATES = new Set([
  "running", "completed", "cancelled", "error", "finalizing",
]);

export type FooterPerformanceStageReference = {
  stageIndex?: number | null;
  stageId?: string | null;
};

export type FooterPerformanceClock = {
  attemptId: string;
  dtSeconds: number;
  stepIndex: number;
  timeSeconds: number;
};

export function footerPerformanceStageMatches(
  performance: RunPerformanceResource | null | undefined,
  expectedStage?: FooterPerformanceStageReference | null,
): boolean {
  if (!performance || !expectedStage) return false;
  const expectedId = expectedStage.stageId?.trim() || null;
  const expectedIndex = expectedStage.stageIndex;
  return Boolean(
    (expectedId && performance.step_id === expectedId) ||
    (typeof expectedIndex === "number" && Number.isSafeInteger(expectedIndex) &&
      performance.stage_index === expectedIndex)
  );
}

export function footerPerformanceMatchesScalarSeries(
  performance: RunPerformanceResource | null | undefined,
  scalarSeries: ScalarWindowResource["series"] | null | undefined,
): boolean {
  return !scalarSeries || Boolean(
    performance && hasFooterPerformanceIdentity(performance.run_id, performance) &&
    sameFooterPerformanceSeries(performance, scalarSeries),
  );
}

/** This reports runner progress, independently of field/scalar sample clocks. */
export function resolveFooterPerformanceStep(
  currentRunId: string | null | undefined,
  performance: RunPerformanceResource | null | undefined,
  expectedStage?: FooterPerformanceStageReference,
  scalarSeries?: ScalarWindowResource["series"] | null,
): number | null {
  if (!hasFooterPerformanceIdentity(currentRunId, performance) ||
      !matchesFooterPerformanceStage(performance, expectedStage) ||
      (scalarSeries && !sameFooterPerformanceSeries(performance, scalarSeries))) return null;
  const step = performance.step_index;
  return typeof step === "number" && Number.isSafeInteger(step) && step >= 0
    ? step : null;
}

/** The physical clock is valid only when it is the exact identified solver row. */
export function resolveFooterPerformanceClock(
  currentRunId: string | null | undefined,
  performance: RunPerformanceResource | null | undefined,
  expectedStage?: FooterPerformanceStageReference,
  scalarSeries?: ScalarWindowResource["series"] | null,
): FooterPerformanceClock | null {
  if (!hasFooterPerformanceIdentity(currentRunId, performance) ||
      !matchesFooterPerformanceStage(performance, expectedStage) ||
      (scalarSeries && !sameFooterPerformanceSeries(performance, scalarSeries))) return null;

  const sample = performance.solver_clock;
  const stepIndex = safeInteger(performance.step_index);
  if (!sample || safeInteger(performance.stage_index) === null || stepIndex === null ||
      safeInteger(sample.step_index) !== stepIndex ||
      !isFiniteNonNegative(sample.time_s) || !isFiniteNonNegative(sample.dt_s)) return null;

  return {
    attemptId: performance.attempt_id!,
    dtSeconds: sample.dt_s,
    stepIndex,
    timeSeconds: sample.time_s,
  };
}

/** Progress fraction is accepted only for the matching run and active stage. */
export function resolveFooterPerformanceProgressFraction(
  currentRunId: string | null | undefined,
  performance: RunPerformanceResource | null | undefined,
  expectedStage?: FooterPerformanceStageReference,
  scalarSeries?: ScalarWindowResource["series"] | null,
): number | null {
  if (!hasFooterPerformanceIdentity(currentRunId, performance) ||
      safeInteger(performance.stage_index) === null ||
      !matchesFooterPerformanceStage(performance, expectedStage) ||
      (scalarSeries && !sameFooterPerformanceSeries(performance, scalarSeries))) return null;
  const fraction = performance.progress_fraction;
  return typeof fraction === "number" && Number.isFinite(fraction) &&
      fraction >= 0 && fraction <= 1
    ? fraction
    : null;
}

export type FooterMeasuredStepRate = {
  attemptId: string;
  elapsedSeconds: number;
  firstStep: number;
  lastStep: number;
  stepCount: number;
  stepsPerSecond: number;
};

/** A measured attempt rate: observed step-index span / monotonic runner span. */
export function resolveFooterPerformanceRate(
  currentRunId: string | null | undefined,
  performance: RunPerformanceResource | null | undefined,
  scalarSeries?: ScalarWindowResource["series"] | null,
  expectedStage?: FooterPerformanceStageReference,
): FooterMeasuredStepRate | null {
  if (!hasFooterPerformanceIdentity(currentRunId, performance) ||
      !matchesFooterPerformanceStage(performance, expectedStage) ||
      (scalarSeries && !sameFooterPerformanceSeries(performance, scalarSeries))) {
    return null;
  }

  const firstStep = safeInteger(performance.first_step_index);
  const lastStep = safeInteger(performance.step_index);
  const elapsedNs = safeInteger(performance.elapsed_monotonic_ns);
  if (firstStep === null || lastStep === null || elapsedNs === null || elapsedNs <= 0) {
    return null;
  }
  const stepCount = lastStep - firstStep;
  if (stepCount < 0) return null;
  const elapsedSeconds = elapsedNs / 1_000_000_000;
  const stepsPerSecond = stepCount / elapsedSeconds;
  if (!Number.isFinite(stepsPerSecond) || stepsPerSecond < 0) return null;

  return {
    attemptId: performance.attempt_id!,
    elapsedSeconds,
    firstStep,
    lastStep,
    stepCount,
    stepsPerSecond,
  };
}

function hasFooterPerformanceIdentity(
  currentRunId: string | null | undefined,
  performance: RunPerformanceResource | null | undefined,
): performance is RunPerformanceResource {
  return Boolean(
    currentRunId && performance && performance.run_id === currentRunId &&
    OBSERVED_PERFORMANCE_STATES.has(performance.state) &&
    hasText(performance.task_id) && hasText(performance.step_id) &&
    hasText(performance.attempt_id) &&
    Number.isSafeInteger(performance.ownership_epoch) &&
    (performance.ownership_epoch ?? -1) >= 0
  );
}

function matchesFooterPerformanceStage(
  performance: RunPerformanceResource,
  expectedStage?: FooterPerformanceStageReference,
): boolean {
  if (!expectedStage) return true;

  const expectedIndex = expectedStage.stageIndex;
  const expectedId = expectedStage.stageId?.trim() || null;
  const observedIndex = performance.stage_index;
  const observedId = performance.step_id?.trim() || null;

  if (expectedId && observedId !== expectedId) return false;
  if (observedIndex !== undefined && observedIndex !== null &&
      safeInteger(observedIndex) === null) return false;
  if (typeof expectedIndex === "number" && Number.isSafeInteger(expectedIndex)) {
    if (observedIndex !== expectedIndex &&
        !(expectedId && observedIndex == null) &&
        !(observedIndex === undefined && !expectedId)) return false;
  }
  return true;
}

function sameFooterPerformanceSeries(
  performance: RunPerformanceResource,
  series: NonNullable<ScalarWindowResource["series"]>,
): boolean {
  return series.run_id === performance.run_id &&
    series.task_id === performance.task_id &&
    series.step_id === performance.step_id &&
    series.attempt_id === performance.attempt_id &&
    series.ownership_epoch === performance.ownership_epoch;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
