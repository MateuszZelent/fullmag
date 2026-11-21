import { describe, expect, it } from "vitest";

import type {
  RunPerformanceResource,
  ScalarWindowResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";

import type { FooterTelemetryStatus } from "./FooterTelemetry.model";
import { resolveFooterStageSelection, resolveFooterStepCounters } from "./footerStepCounters";

const status: FooterTelemetryStatus = {
  energies: null,
  metrics: { steps_per_second: null, total_steps: 0 },
  run: {
    calibration_id: null,
    requested_device: "gpu",
    resolved_device: "gpu",
    run_id: "run-current",
    selection_confidence: null,
    selection_reason: "explicit_device_request",
    solver_steps: 0,
    solver_time: 20e-9,
    stage_count: 6,
    stage_index: 3,
    stage_label: "Stage 4",
  },
  sessionId: "session-current",
  sessionEpoch: "session-current@1",
  requestScopeEpoch: "api:1",
  scalarsRevision: 1,
  solver: { converged: null, dt: null, max_torque_T: null, state: "running" },
};

function stageExecution(overrides: Partial<StageExecutionResource> = {}): StageExecutionResource {
  return {
    session_id: "session-current",
    session_epoch: "session-current@1",
    request_scope_epoch: "api:1",
    run_id: "run-current",
    runtime_state: "running",
    active_stage_index: 3,
    completed_stage_indexes: [0, 1, 2],
    total_stages: 6,
    stage_statuses: ["completed", "completed", "completed", "running", "pending", "pending"],
    stages: [
      { index: 0, stage_id: "stage-1", status: "completed", completed_step: 12_960 },
      { index: 1, stage_id: "stage-2", status: "completed", completed_step: 35_545 },
      { index: 2, stage_id: "stage-3", status: "completed", completed_step: 3 },
      { index: 3, stage_id: "stage-4", status: "running" },
    ],
    revision: 5,
    ...overrides,
  } as StageExecutionResource;
}

function performance(overrides: Partial<RunPerformanceResource> = {}): RunPerformanceResource {
  return {
    state: "running",
    run_id: "run-current",
    task_id: "task-4",
    step_id: "stage-4",
    attempt_id: "attempt-4a",
    ownership_epoch: 2,
    stage_index: 3,
    step_index: 73,
    elapsed_monotonic_ns: 1_000_000_000,
    first_step_index: 0,
    sample_sequence: 74,
    unique_step_callback_records: 74,
    gpu_scope: "whole_device",
    points: [],
    rows_dropped: 0,
    revision: "performance-4a",
    ...overrides,
  } as RunPerformanceResource;
}

function scalarWindow(
  step: number,
  overrides: Partial<ScalarWindowResource> = {},
): ScalarWindowResource {
  return {
    columns: ["step", "mx", "my", "mz"],
    current_observation: {
      session_id: "session-current",
      request_scope_epoch: "api:1",
      run_id: "run-current",
      scalar_revision: 7,
      source_step: step,
    },
    observation_frames: [],
    returned_rows: 1,
    revision: 7,
    rows: [[step, 1, 0, 0]],
    series: {
      run_id: "run-current",
      task_id: "task-4",
      step_id: "stage-4",
      case_id: "default",
      attempt_id: "attempt-4a",
      ownership_epoch: 2,
    },
    total_rows: 1,
    ...overrides,
  } as ScalarWindowResource;
}

describe("footer stage and run step counters", () => {
  it("adds completed stage counts to the active stage's solver step", () => {
    const result = resolveFooterStepCounters(status, stageExecution(), performance(), null, "ready");

    expect(result).toMatchObject({
      activeStageIndex: 3,
      stageSteps: 73,
      runSteps: 48_581,
      runStepsExact: true,
      activeAttemptId: "attempt-4a",
    });
  });

  it("uses the same-stage scalar sample when it identifies a newer retry", () => {
    const currentSample = scalarWindow(11, {
      series: {
        run_id: "run-current",
        task_id: "task-4",
        step_id: "stage-4",
        case_id: "default",
        attempt_id: "attempt-4b",
        ownership_epoch: 3,
      },
    });
    const result = resolveFooterStepCounters(
      status,
      stageExecution(),
      performance({ attempt_id: "attempt-4a", ownership_epoch: 2, step_index: 99 }),
      currentSample,
      "ready",
    );

    expect(result).toMatchObject({
      stageSteps: 11,
      runSteps: 48_519,
      runStepsExact: true,
      activeAttemptId: "attempt-4b",
      activeStepSource: "sample",
    });
  });

  it("rejects counters from another stage, run, or session", () => {
    const otherStage = resolveFooterStepCounters(
      status,
      stageExecution(),
      performance({ step_id: "stage-3", stage_index: 2 }),
      null,
      "ready",
    );
    const otherRun = resolveFooterStepCounters(
      status,
      stageExecution({ run_id: "run-previous" }),
      performance(),
      null,
      "ready",
    );
    const otherSession = resolveFooterStepCounters(
      status,
      stageExecution({ session_epoch: "session-previous@1" }),
      performance(),
      null,
      "ready",
    );

    expect(otherStage).toMatchObject({ stageSteps: null, runSteps: 48_508, runStepsExact: false });
    expect(otherRun).toMatchObject({ stageSteps: null, runSteps: null });
    expect(otherSession).toMatchObject({ stageSteps: null, runSteps: null });
  });

  it("uses published completed counts as a lower bound when a completed stage has a gap", () => {
    const execution = stageExecution({
      stages: [
        { index: 0, stage_id: "stage-1", status: "completed", completed_step: 12_960 },
        { index: 1, stage_id: "stage-2", status: "completed" },
        { index: 2, stage_id: "stage-3", status: "completed", completed_step: 3 },
        { index: 3, stage_id: "stage-4", status: "running" },
      ],
    });
    const result = resolveFooterStepCounters(status, execution, performance({ step_index: 10 }), null, "ready");

    expect(result).toMatchObject({
      stageSteps: 10,
      runSteps: 12_973,
      runStepsExact: false,
      missingStageIndexes: [1],
    });
  });

  it("reports a verified stage handoff without inventing an active stage", () => {
    const handoffStatus = {
      ...status,
      solver: { ...status.solver, state: "completed" },
    };
    const execution = stageExecution({
      active_stage_index: null,
      completed_stage_indexes: [0, 1, 2],
      stage_statuses: ["completed", "completed", "completed", "pending", "pending", "pending"],
      stages: [
        { index: 0, stage_id: "stage-1", status: "completed", completed_step: 12_960 },
        { index: 1, stage_id: "stage-2", status: "completed", completed_step: 35_545 },
        { index: 2, stage_id: "stage-3", status: "completed", completed_step: 3 },
        { index: 3, stage_id: "stage-4", status: "pending" },
      ],
    });
    const result = resolveFooterStepCounters(handoffStatus, execution, performance(), null, "ready");
    const selection = resolveFooterStageSelection(handoffStatus, execution);

    expect(result).toMatchObject({
      activeStageIndex: null,
      stageSteps: null,
      runSteps: 48_508,
      runStepsExact: true,
      handoff: { fromStageIndex: 2, toStageIndex: 3 },
    });
    expect(selection).toMatchObject({
      handoff: { fromStageIndex: 2, toStageIndex: 3 },
      runActive: true,
      terminal: false,
    });
    expect(selection?.activeStage).toBeNull();
  });

  it("does not reuse active attempt progress after a run becomes terminal", () => {
    const execution = stageExecution({
      active_stage_index: null,
      runtime_state: "completed",
      completed_stage_indexes: [0, 1, 2, 3],
      total_stages: 6,
      stage_statuses: ["completed", "completed", "completed", "completed", "pending", "pending"],
      stages: [
        { index: 0, stage_id: "stage-1", status: "completed", completed_step: 12_960 },
        { index: 1, stage_id: "stage-2", status: "completed", completed_step: 35_545 },
        { index: 2, stage_id: "stage-3", status: "completed", completed_step: 3 },
        { index: 3, stage_id: "stage-4", status: "completed", completed_step: 17 },
      ],
    });
    const terminalStatus = {
      ...status,
      solver: { ...status.solver, state: "completed" },
    };
    const result = resolveFooterStepCounters(
      terminalStatus,
      execution,
      performance({ step_index: 999 }),
      null,
      "ready",
    );

    expect(result).toMatchObject({
      activeStageIndex: null,
      stageSteps: null,
      runSteps: 48_525,
      runStepsExact: true,
      activeAttemptId: null,
    });
  });

  it("selects the sole running stage row when active_stage_index is temporarily absent", () => {
    const execution = stageExecution({
      active_stage_index: null,
      stages: [
        { index: 0, stage_id: "stage-1", status: "completed", completed_step: 12_960 },
        { index: 1, stage_id: "stage-2", status: "completed", completed_step: 35_545 },
        { index: 2, stage_id: "stage-3", status: "completed", completed_step: 3 },
        { index: 3, stage_id: "stage-4", status: "running" },
      ],
    });
    const selection = resolveFooterStageSelection(status, execution);
    const result = resolveFooterStepCounters(
      status,
      execution,
      performance({ step_index: 9 }),
      null,
      "ready",
    );

    expect(selection).toMatchObject({ activeStageIndex: 3, activeStageId: "stage-4", handoff: null });
    expect(result).toMatchObject({ activeStageIndex: 3, stageSteps: 9, runSteps: 48_517 });
  });

  it("prefers the sole active stage row over a stale completed active index", () => {
    const execution = stageExecution({
      active_stage_index: 2,
      stages: [
        { index: 0, stage_id: "stage-1", status: "completed", completed_step: 12_960 },
        { index: 1, stage_id: "stage-2", status: "completed", completed_step: 35_545 },
        { index: 2, stage_id: "stage-3", status: "completed", completed_step: 3 },
        { index: 3, stage_id: "stage-4", status: "running" },
      ],
    });
    const selection = resolveFooterStageSelection(status, execution);

    expect(selection).toMatchObject({ activeStageIndex: 3, activeStageId: "stage-4" });
  });

  it("uses a qualified scalar sample while the performance resource is stale", () => {
    const result = resolveFooterStepCounters(
      status,
      stageExecution(),
      performance({ attempt_id: "attempt-4a", step_index: 99 }),
      scalarWindow(11),
      "stale",
    );

    expect(result).toMatchObject({
      stageSteps: 11,
      runSteps: 48_519,
      runStepsExact: true,
      activeAttemptId: "attempt-4a",
      activeStepSource: "sample",
    });
  });

  it("does not present an exact zero when all counters are missing during an active stage", () => {
    const execution = stageExecution({
      stages: [
        { index: 0, stage_id: "stage-1", status: "completed" },
        { index: 1, stage_id: "stage-2", status: "completed" },
        { index: 2, stage_id: "stage-3", status: "completed" },
        { index: 3, stage_id: "stage-4", status: "running" },
      ],
    });
    const result = resolveFooterStepCounters(status, execution, null, null, "idle");

    expect(result).toMatchObject({
      stageSteps: null,
      runSteps: null,
      runStepsExact: false,
      missingStageIndexes: [0, 1, 2, 3],
    });
  });
});
