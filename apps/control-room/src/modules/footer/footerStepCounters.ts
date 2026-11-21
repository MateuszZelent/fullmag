import type {
  RunPerformanceResource,
  ScalarWindowResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";

import {
  resolveFooterScalarResourceSample,
  type FooterTelemetryStatus,
} from "./FooterTelemetry.model";
import { resolveFooterPerformanceStep } from "./footerPerformanceProgress";

type StageExecutionRecord = StageExecutionResource["stages"][number];
type FooterStageHandoff = { fromStageIndex: number; toStageIndex: number };

export type FooterStageExecutionIndex = {
  completedIndexes: ReadonlySet<number>;
  records: ReadonlyMap<number, StageExecutionRecord>;
  totalStages: number;
};

export type FooterStageSelection = {
  activeStage: StageExecutionRecord | null;
  activeStageId: string | null;
  activeStageIndex: number | null;
  execution: StageExecutionResource | null;
  executionIndex: FooterStageExecutionIndex | null;
  handoff: FooterStageHandoff | null;
  runActive: boolean;
  terminal: boolean;
  totalStages: number | null;
};

export type FooterStepCounters = {
  activeAttemptId: string | null;
  activeStageIndex: number | null;
  activeStepSource: "solver" | "sample" | null;
  handoff: FooterStageHandoff | null;
  missingStageIndexes: number[];
  runSteps: number | null;
  runStepsExact: boolean;
  stageSteps: number | null;
};

const ACTIVE_STATES = new Set(["active", "paused", "running"]);
const PENDING_STATES = new Set(["pending", "queued", "ready", "waiting"]);
const SKIPPED_STATES = new Set(["skipped"]);
const PARTIAL_TERMINAL_STATES = new Set(["cancelled", "canceled", "failed"]);
const TERMINAL_STATES = new Set([
  "cancelled", "canceled", "completed", "error", "failed", "stopped",
]);

function stateToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeIndex(value: unknown, total: number): number | null {
  const index = safeCount(value);
  return index !== null && index < total ? index : null;
}

function indexStageExecution(
  execution: StageExecutionResource,
  totalStages: number,
): FooterStageExecutionIndex {
  const records = new Map<number, StageExecutionRecord>();
  const duplicateIndexes = new Set<number>();
  for (const record of execution.stages) {
    const index = safeIndex(record.index, totalStages);
    if (index === null) continue;
    if (records.has(index)) duplicateIndexes.add(index);
    else records.set(index, record);
  }
  for (const index of duplicateIndexes) records.delete(index);
  return {
    completedIndexes: new Set(execution.completed_stage_indexes),
    records,
    totalStages,
  };
}

function stageRecordAt(view: FooterStageExecutionIndex, index: number): StageExecutionRecord | null {
  return view.records.get(index) ?? null;
}

function stageStatusAt(
  view: FooterStageExecutionIndex,
  execution: StageExecutionResource,
  index: number,
): string {
  if (view.completedIndexes.has(index)) return "completed";
  const recordState = stateToken(stageRecordAt(view, index)?.status);
  return recordState || stateToken(execution.stage_statuses[index]);
}

function matchesCurrentRun(
  status: FooterTelemetryStatus | null | undefined,
  execution: StageExecutionResource,
): boolean {
  return Boolean(
    status?.run?.run_id &&
    status.sessionId &&
    status.sessionEpoch &&
    status.requestScopeEpoch &&
    execution.session_id === status.sessionId &&
    execution.session_epoch === status.sessionEpoch &&
    execution.request_scope_epoch === status.requestScopeEpoch &&
    execution.run_id === status.run.run_id
  );
}

function isTerminalRun(
  status: FooterTelemetryStatus,
  execution: StageExecutionResource,
): boolean {
  const executionState = stateToken(execution.runtime_state);
  if (ACTIVE_STATES.has(executionState)) return false;
  if (TERMINAL_STATES.has(executionState)) return true;
  return TERMINAL_STATES.has(stateToken(status.solver.state));
}

function isRunActive(
  status: FooterTelemetryStatus,
  execution: StageExecutionResource,
): boolean {
  const executionState = stateToken(execution.runtime_state);
  if (TERMINAL_STATES.has(executionState)) return false;
  return ACTIVE_STATES.has(executionState) ||
    ACTIVE_STATES.has(stateToken(status.solver.state));
}

function resolveHandoff(
  execution: StageExecutionResource,
  view: FooterStageExecutionIndex,
): FooterStageHandoff | null {
  let next = 0;
  while (next < view.totalStages) {
    const state = stageStatusAt(view, execution, next);
    if (state !== "completed" && !SKIPPED_STATES.has(state)) break;
    next += 1;
  }
  if (next === 0 || next >= view.totalStages) return null;
  if (!PENDING_STATES.has(stageStatusAt(view, execution, next))) return null;
  return { fromStageIndex: next - 1, toStageIndex: next };
}

/**
 * Resolves a stage only from the current session/run projection. A matching
 * execution payload with no active stage suppresses the thinner status index;
 * that index may still describe the stage that just completed.
 */
export function resolveFooterStageSelection(
  status: FooterTelemetryStatus | null | undefined,
  stageExecution: StageExecutionResource | null | undefined,
): FooterStageSelection | null {
  if (!status?.run?.run_id) return null;

  if (stageExecution) {
    if (!matchesCurrentRun(status, stageExecution)) return null;
    const totalStages = safeCount(stageExecution.total_stages);
    if (totalStages === null || totalStages <= 0) return null;
    const executionIndex = indexStageExecution(stageExecution, totalStages);
    const terminal = isTerminalRun(status, stageExecution);
    const runActive = !terminal && isRunActive(status, stageExecution);
    const explicitIndex = safeIndex(stageExecution.active_stage_index, totalStages);
    const explicitState = explicitIndex === null
      ? ""
      : stageStatusAt(executionIndex, stageExecution, explicitIndex);

    if (!terminal && explicitIndex !== null &&
        (ACTIVE_STATES.has(explicitState) || !explicitState)) {
      const activeStage = stageRecordAt(executionIndex, explicitIndex);
      return {
        activeStage,
        activeStageId: activeStage?.stage_id?.trim() || null,
        activeStageIndex: explicitIndex,
        execution: stageExecution,
        executionIndex,
        handoff: null,
        runActive,
        terminal: false,
        totalStages,
      };
    }

    let multipleActiveStages = false;
    if (!terminal && (explicitIndex === null || !ACTIVE_STATES.has(explicitState))) {
      let activeIndex: number | null = null;
      for (let index = 0; index < totalStages; index += 1) {
        if (!ACTIVE_STATES.has(stageStatusAt(executionIndex, stageExecution, index))) continue;
        if (activeIndex !== null) {
          multipleActiveStages = true;
          break;
        }
        activeIndex = index;
      }
      if (activeIndex !== null && !multipleActiveStages) {
        const activeStage = stageRecordAt(executionIndex, activeIndex);
        return {
          activeStage,
          activeStageId: activeStage?.stage_id?.trim() || null,
          activeStageIndex: activeIndex,
          execution: stageExecution,
          executionIndex,
          handoff: null,
          runActive,
          terminal: false,
          totalStages,
        };
      }
    }

    const handoff = !terminal && runActive && !multipleActiveStages
      ? resolveHandoff(stageExecution, executionIndex)
      : null;
    return {
      activeStage: null,
      activeStageId: null,
      activeStageIndex: null,
      execution: stageExecution,
      executionIndex,
      handoff,
      runActive,
      terminal,
      totalStages,
    };
  }

  const totalStages = safeCount(status.run.stage_count);
  const stageIndex = totalStages === null
    ? null
    : safeIndex(status.run.stage_index, totalStages);
  const terminal = TERMINAL_STATES.has(stateToken(status.solver.state));
  if ((!terminal && !ACTIVE_STATES.has(stateToken(status.solver.state))) ||
      totalStages === null || totalStages <= 0 || stageIndex === null) return null;

  return {
    activeStage: null,
    activeStageId: null,
    activeStageIndex: stageIndex,
    execution: null,
    executionIndex: null,
    handoff: null,
    runActive: !terminal,
    terminal,
    totalStages,
  };
}

function matchingScalarObservation(
  status: FooterTelemetryStatus,
  window: ScalarWindowResource | null | undefined,
): { series: NonNullable<ScalarWindowResource["series"]>; step: number } | null {
  const sample = resolveFooterScalarResourceSample(status, window);
  const series = sample?.series;
  const step = safeCount(sample?.row.step);
  if (!sample || !series || step === null || series.run_id !== status.run?.run_id ||
      !series.task_id.trim() || !series.step_id.trim() || !series.attempt_id.trim() ||
      safeCount(series.ownership_epoch) === null) return null;
  return { series, step };
}

function completedStageStepCount(
  execution: StageExecutionResource,
  view: FooterStageExecutionIndex,
  index: number,
  terminal: boolean,
): { count: number; known: boolean; missing: boolean } {
  const state = stageStatusAt(view, execution, index);
  if (SKIPPED_STATES.has(state)) return { count: 0, known: true, missing: false };
  if (PENDING_STATES.has(state)) return { count: 0, known: false, missing: false };

  const record = stageRecordAt(view, index);
  if (state === "completed" || PARTIAL_TERMINAL_STATES.has(state) ||
      (terminal && ACTIVE_STATES.has(state))) {
    const count = safeCount(record?.completed_step);
    return count === null
      ? { count: 0, known: false, missing: true }
      : { count, known: true, missing: false };
  }
  return { count: 0, known: false, missing: true };
}

function emptyStepCounters(): FooterStepCounters {
  return {
    activeAttemptId: null,
    activeStageIndex: null,
    activeStepSource: null,
    handoff: null,
    missingStageIndexes: [],
    runSteps: null,
    runStepsExact: false,
    stageSteps: null,
  };
}

/**
 * Counts completed stage-local steps once, then adds only a same-stage,
 * same-attempt active solver step or accepted scalar observation. Missing stage
 * counters make the run value a lower bound instead of a fabricated total.
 */
export function resolveFooterStepCounters(
  status: FooterTelemetryStatus | null | undefined,
  stageExecution: StageExecutionResource | null | undefined,
  performance: RunPerformanceResource | null | undefined,
  scalarWindow: ScalarWindowResource | null | undefined,
  performanceStatus: string | undefined,
  resolvedSelection?: FooterStageSelection | null,
): FooterStepCounters {
  const selection = resolvedSelection ?? resolveFooterStageSelection(status, stageExecution);
  if (!status || !selection) return emptyStepCounters();

  const execution = selection.execution;
  const view = selection.executionIndex;
  const totalStages = selection.totalStages ?? 0;
  const activeStageIndex = selection.activeStageIndex;
  const missing = new Set<number>();
  let knownRunSteps = 0;
  let hasKnownRunSteps = false;
  const throughIndex = activeStageIndex !== null
    ? activeStageIndex - 1
    : selection.terminal
      ? totalStages - 1
      : selection.handoff?.fromStageIndex ?? -1;

  if (view && execution) {
    for (let index = 0; index <= throughIndex; index += 1) {
      const state = stageStatusAt(view, execution, index);
      const previous = completedStageStepCount(execution, view, index, selection.terminal);
      knownRunSteps += previous.count;
      hasKnownRunSteps ||= previous.known;
      if (previous.missing || (activeStageIndex !== null && PENDING_STATES.has(state))) {
        missing.add(index);
      }
    }
  } else if (activeStageIndex !== null) {
    for (let index = 0; index < activeStageIndex; index += 1) missing.add(index);
  }

  let stageSteps: number | null = null;
  let activeAttemptId: string | null = null;
  let activeStepSource: FooterStepCounters["activeStepSource"] = null;
  if (!selection.terminal && activeStageIndex !== null && status.run?.run_id) {
    const scalar = matchingScalarObservation(status, scalarWindow);
    const stageReference = {
      stageIndex: activeStageIndex,
      stageId: selection.activeStageId,
    };
    const solverStep = performanceStatus === "ready"
      ? resolveFooterPerformanceStep(
          status.run.run_id,
          performance,
          stageReference,
          scalar?.series ?? null,
        )
      : null;

    if (solverStep !== null) {
      stageSteps = solverStep;
      activeAttemptId = performance?.attempt_id?.trim() || null;
      activeStepSource = "solver";
    } else if (scalar && selection.activeStageId &&
        scalar.series.step_id === selection.activeStageId) {
      stageSteps = scalar.step;
      activeAttemptId = scalar.series.attempt_id;
      activeStepSource = "sample";
    }

    if (stageSteps === null) missing.add(activeStageIndex);
    else {
      knownRunSteps += stageSteps;
      hasKnownRunSteps = true;
    }
  }

  const accountingScopeKnown = activeStageIndex !== null ||
    selection.handoff !== null || selection.terminal;
  const runSteps = accountingScopeKnown && hasKnownRunSteps ? knownRunSteps : null;
  return {
    activeAttemptId,
    activeStageIndex,
    activeStepSource,
    handoff: selection.handoff,
    missingStageIndexes: [...missing].sort((left, right) => left - right),
    runSteps,
    runStepsExact: runSteps !== null && missing.size === 0,
    stageSteps,
  };
}
