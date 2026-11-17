import { describe, expect, it } from "vitest";

import type {
  CommandQueueStatusResource,
  SimulationPreparationResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";

import {
  buildRunProgressModel,
  estimateRemainingMs,
  formatRunDuration,
  normalizeRunStepState,
  runStepElapsedMs,
} from "./runProgressModel";

const readyPreparation: SimulationPreparationResource = {
  active_stage_id: null,
  completed_at_unix_ms: 4_000,
  failure: null,
  log_tail: [
    { level: "warning", message: "Airbox padding clipped", stage_id: "meshing", timestamp_unix_ms: 2_500 },
  ],
  preparation_id: "prep-1",
  receipt: null,
  requested_execution: { backend: "fem", device: "gpu", precision: "double" },
  resolved_execution: { backend: "fem", device: "gpu", precision: "double" },
  revision: 3,
  stages: [
    {
      completed_at_unix_ms: 1_500, detail: "Validated", duration_ms: 500, id: "validation",
      label: "Validation", started_at_unix_ms: 1_000, status: "completed",
    },
    {
      completed_at_unix_ms: 4_000, detail: "Meshed", duration_ms: 2_500, id: "meshing",
      label: "Meshing", started_at_unix_ms: 1_500, status: "completed",
    },
    {
      completed_at_unix_ms: 4_000, detail: "", duration_ms: 0, id: "ready",
      label: "Ready", started_at_unix_ms: 4_000, status: "completed",
    },
  ],
  started_at_unix_ms: 1_000,
  status: "ready",
};

const execution: StageExecutionResource = {
  active_stage_index: 1,
  active_stage_kind: "relax",
  completed_stage_indexes: [0],
  request_scope_epoch: "scope",
  revision: 9,
  run_id: "run-1",
  runtime_state: "running",
  session_epoch: "epoch",
  session_id: "session",
  stage_statuses: ["completed", "running", "pending"],
  stages: [
    {
      completed_at_unix_ms: 10_000, converged: true, index: 0, kind: "relax", label: "Initial relax",
      reason: "torque", stage_id: "s0", started_at_unix_ms: 4_000, status: "completed",
    },
    {
      converged: false, index: 1, kind: "relax", metric_kind: "max_torque_apm", metric_unit: "A/m",
      metric_value: 3.2e-3, progress_percent: 40, stage_id: "s1", started_at_unix_ms: 10_000,
      status: "running", threshold: 1e-5,
    },
  ],
  total_stages: 3,
};

const commands: CommandQueueStatusResource = {
  accepted_count: 0,
  can_accept_commands: true,
  commands: [
    {
      command_id: "run-cmd", completed_at_unix_ms: null, created_at_unix_ms: 900,
      dispatched_at_unix_ms: 950, kind: "run_study", seq: 1, status: "running",
    },
  ],
  completed_count: 0,
  dispatched_count: 1,
  failed_count: 0,
  pending_count: 0,
  rejected_count: 0,
  revision: 1,
  running_count: 1,
  runtime_controls: [],
};

describe("runProgressModel", () => {
  it("orders preparation before every authored stage and fills unpublished stages", () => {
    const model = buildRunProgressModel({
      commandQueue: commands,
      currentRun: null,
      meshBuild: null,
      preparation: readyPreparation,
      sessionSolverState: "running",
      stageExecution: execution,
    });

    expect(model.phase).toBe("running");
    expect(model.steps.map((step) => step.id)).toEqual([
      "preparation:prep-1", "stage:s0", "stage:s1", "stage:2",
    ]);
    expect(model.steps[0]).toMatchObject({ state: "completed", percent: 100, subtitle: "FEM GPU double" });
    expect(model.steps[0].children.map((child) => child.title)).toEqual(["Validation", "Meshing"]);
    expect(model.steps[1]).toMatchObject({
      message: "Converged: torque tolerance reached",
      messageTone: "success",
      title: "Initial relax",
      subtitle: "Relaxation",
    });
    expect(model.steps[2]).toMatchObject({ state: "active", percent: 40, ordinal: 2 });
    expect(model.steps[2].metric).toEqual({ label: "Max torque", target: "1.00e-5 A/m", value: "3.20e-3 A/m" });
    expect(model.steps[3]).toMatchObject({ state: "pending", title: "Stage 3", percent: null });
    expect(model.focus).toBe("Stage 2 of 3: Relaxation");
    expect(model.overallPercent).toBe(47);
  });

  it("surfaces a failed stage with the error of the command that drove it", () => {
    const model = buildRunProgressModel({
      commandQueue: {
        ...commands,
        commands: [{ ...commands.commands[0], error: "CUDA out of memory", status: "failed" }],
      },
      currentRun: null,
      meshBuild: null,
      preparation: readyPreparation,
      sessionSolverState: "failed",
      stageExecution: {
        ...execution,
        stages: [
          execution.stages[0],
          { ...execution.stages[1], command_id: "run-cmd", status: "failed" },
        ],
      },
    });

    expect(model.phase).toBe("failed");
    expect(model.failure).toBe("CUDA out of memory");
    expect(model.steps[2]).toMatchObject({ messageTone: "danger", state: "failed" });
    expect(model.activity.find((row) => row.operationId === "command:run-cmd")).toMatchObject({
      detail: "CUDA out of memory",
      tone: "danger",
    });
  });

  it("reports preparation progress before any stage exists", () => {
    const model = buildRunProgressModel({
      commandQueue: null,
      currentRun: null,
      meshBuild: null,
      preparation: {
        ...readyPreparation,
        completed_at_unix_ms: null,
        status: "running",
        stages: [
          readyPreparation.stages[0],
          { ...readyPreparation.stages[1], progress_percent: 50, status: "active", completed_at_unix_ms: null },
        ],
      },
      sessionSolverState: null,
      stageExecution: null,
    });

    expect(model.phase).toBe("preparing");
    expect(model.overallPercent).toBe(75);
    expect(model.focus).toBe("Meshing");
  });

  it("keeps an idle session empty instead of inventing steps", () => {
    const model = buildRunProgressModel({
      commandQueue: null,
      currentRun: null,
      meshBuild: null,
      preparation: null,
      sessionSolverState: null,
      stageExecution: null,
    });
    expect(model).toMatchObject({ activity: [], phase: "idle", steps: [], overallPercent: null });
  });

  it("normalizes runtime vocabularies and timing helpers", () => {
    expect(normalizeRunStepState("Converged")).toBe("completed");
    expect(normalizeRunStepState("canceled")).toBe("cancelled");
    expect(normalizeRunStepState("queued")).toBe("pending");
    expect(estimateRemainingMs(2, 10_000)).toBeNull();
    expect(estimateRemainingMs(25, 10_000)).toBe(30_000);
    expect(formatRunDuration(850)).toBe("850 ms");
    expect(formatRunDuration(75_000)).toBe("1:15");
    expect(formatRunDuration(3_725_000)).toBe("1:02:05");
    const model = buildRunProgressModel({
      commandQueue: null, currentRun: null, meshBuild: null, preparation: null,
      sessionSolverState: "running", stageExecution: execution,
    });
    expect(runStepElapsedMs(model.steps[0], 99_000)).toBe(6_000);
    expect(runStepElapsedMs(model.steps[1], 13_000)).toBe(3_000);
  });
});
