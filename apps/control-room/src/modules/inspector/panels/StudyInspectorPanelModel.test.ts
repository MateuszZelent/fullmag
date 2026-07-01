import { describe, expect, it } from "vitest";

import {
  resolveCommandSummary,
  resolveStudyInspectorModel,
  studySnapshotFromScene,
} from "./StudyInspectorPanelModel";

const TORQUE_TOLERANCE_FOR_1E_4_T = 1e-4 / (4 * Math.PI * 1e-7);

describe("StudyInspectorPanelModel", () => {
  it("projects stage authoring, boundary policy, runtime progress, and max torque", () => {
    const snapshot = studySnapshotFromScene({
      study: {
        demag_enabled: false,
        demag_realization: "poisson_robin",
        exchange_enabled: true,
        external_field: [0.01, 0, -0.002],
        fem_demag_solver_policy: { linear_solver: "cg" },
        requested_backend: "fem",
        requested_cpu_threads: 8,
        requested_device: "gpu",
        requested_mode: "strict",
        requested_precision: "double",
        solver: { integrator: "rk45" },
        stages: [
          {
            energy_tolerance: "1e-8",
            entrypoint_kind: "relax",
            kind: "relax",
            max_steps: "200",
            relax_algorithm: "llg_overdamped",
            torque_tolerance_apm: TORQUE_TOLERANCE_FOR_1E_4_T,
            max_physical_time_s: "2e-9",
          },
          {
            entrypoint_kind: "run",
            kind: "run",
            stage_id: "scene-run",
            until_seconds: "5e-9",
          },
        ],
      },
    } as never);

    const model = resolveStudyInspectorModel({
      currentRun: {
        active_stage_index: 0,
        artifact_dir: "/tmp/fullmag/run-1",
        requested_backend: "fem",
        requested_device: "gpu",
        requested_mode: "strict",
        requested_precision: "double",
        revision: 3,
        run_id: "run-1",
        session_id: "session-1",
        started_at: "2026-05-12T09:00:00Z",
        status: "running",
        total_steps: 12,
      } as never,
      energyHistory: {
        returned_rows: 50,
        total_rows: 50,
        rows: Array.from({ length: 50 }, (_, i) => ({
          step: i,
          total: i === 49 ? 1.00000001e-7 : 1e-7,
        })),
      } as never,
      selectedNodeId: "model:study:stages:stage:runtime-run",
      snapshot,
      solverStatus: {
        can_accept_commands: true,
        is_busy: true,
        max_torque_Apm: 0.003 / (4 * Math.PI * 1e-7),
        max_torque_T: 0.003,
        revision: 4,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        step_index: 50,
        warnings: [],
        sim_time_seconds: 5e-10,
      } as never,
      stageExecution: {
        active_stage_index: 0,
        active_stage_kind: "relax",
        completed_stage_indexes: [],
        revision: 5,
        runtime_state: "running",
        stage_statuses: ["completed", "running"],
        stages: [
          { stage_id: "runtime-relax", status: "completed" },
          { stage_id: "runtime-run", status: "running" },
        ],
        total_stages: 2,
      } as never,
    });

    expect(model.selectedStage).toMatchObject({
      index: 1,
      kind: "run",
      label: "Run 2",
      progressPercent: 0,
      stageId: "runtime-run",
      status: "running",
      untilSeconds: "5e-9",
    });
    expect(model.stages[0].progressPercent).toBe(100);
    expect(model.boundary).toEqual({
      demagEnabled: "disabled",
      demagRealization: "poisson_robin",
      exchangeEnabled: "enabled",
      externalField: "0.01, 0, -0.002 T",
      femDemagSolverPolicy: '{"linear_solver":"cg"}',
      solver: '{"integrator":"rk45"}',
    });
    expect(model.requested).toEqual({
      backend: "fem",
      cpuThreads: "8",
      device: "gpu",
      mode: "strict",
      precision: "double",
    });
    expect(model.runtime).toMatchObject({
      activeStageLabel: "Relax 1",
      commandBadge: "pending",
      commandError: null,
      commandId: null,
      commandLabel: "Command queue pending",
      maxTorque: "3.000000e-3 T",
      progressPercent: 25,
      relaxTorqueStop: {
        current: "3.000000e-3 T / 2.387324e3 A/m",
        status: "30.0x above threshold",
        threshold: "1.000000e-4 T / 7.957747e1 A/m",
      },
      relaxEnergyStop: {
        current: "1.000000e-15 J",
        status: "0.0000100% of threshold",
        threshold: "1.000000e-8 J",
      },
      relaxTimeStop: {
        budget: "2.000000e-9 s",
        elapsed: "5.000000e-10 s",
        status: "25.0% of budget",
      },
      runId: "run-1",
      state: "running",
    });
  });

  it("summarizes active and failed command queue states", () => {
    expect(
      resolveCommandSummary({
        accepted_count: 0,
        can_accept_commands: false,
        commands: [
          {
            command_id: "cmd-1",
            created_at_unix_ms: 1,
            kind: "compute_fields",
            seq: 1,
            status: "running",
          },
        ],
        completed_count: 0,
        dispatched_count: 0,
        failed_count: 0,
        pending_count: 0,
        rejected_count: 0,
        revision: 1,
        running_count: 1,
      } as never),
    ).toMatchObject({
      badge: "running",
      commandId: "cmd-1",
      error: null,
      label: "Compute Fields running",
    });

    expect(
      resolveCommandSummary({
        accepted_count: 0,
        can_accept_commands: true,
        commands: [
          {
            command_id: "cmd-1",
            created_at_unix_ms: 1,
            kind: "compute_fields",
            seq: 1,
            status: "running",
          },
          {
            command_id: "cmd-2",
            created_at_unix_ms: 2,
            error: "stage target mismatch",
            kind: "pause",
            seq: 2,
            status: "failed",
          },
        ],
        completed_count: 0,
        dispatched_count: 0,
        failed_count: 1,
        pending_count: 0,
        rejected_count: 0,
        revision: 2,
        running_count: 1,
      } as never),
    ).toMatchObject({
      badge: "failed",
      commandId: "cmd-2",
      error: "stage target mismatch",
      label: "Pause failed",
    });
  });

  it("keeps terminal relaxation completion details for a selected completed stage", () => {
    const snapshot = studySnapshotFromScene({
      study: {
        stages: [
          {
            kind: "relax",
            stage_id: "stage-relax",
            torque_tolerance_apm: 80,
            max_steps: "1000",
          },
        ],
      },
    } as never);

    const model = resolveStudyInspectorModel({
      commandQueue: null,
      currentRun: null,
      selectedStageRef: {
        nodeId: "model:study:stages:stage:stage-relax",
        stageId: "stage-relax",
        stageIndex: 0,
      },
      snapshot,
      solverStatus: {
        can_accept_commands: true,
        converged: true,
        is_busy: false,
        max_torque_Apm: 75,
        revision: 12,
        runtime_state: "completed",
        runtime_status_code: "completed",
        runtime_status_kind: "completed",
        session_status: "completed",
        warnings: [],
      } as never,
      stageExecution: {
        active_stage_index: null,
        active_stage_kind: null,
        completed_stage_indexes: [0],
        revision: 13,
        runtime_state: "completed",
        stage_statuses: ["completed"],
        stages: [
          {
            artifact_refs: ["runs/run-1/stages/stage-relax"],
            checkpoint_ref: "cp-relaxed",
            command_id: "cmd-relax",
            completed_at_unix_ms: 1_700_000_010_000,
            index: 0,
            kind: "relax",
            metric_name: "max_torque_apm",
            metric_value: 75,
            reason: "torque",
            stage_id: "stage-relax",
            status: "completed",
            threshold: 80,
          },
        ],
        total_stages: 1,
      } as never,
    });

    expect(model.selectedStage).toMatchObject({
      artifactRefs: ["runs/run-1/stages/stage-relax"],
      checkpointRef: "cp-relaxed",
      commandId: "cmd-relax",
      completedAtUnixMs: 1_700_000_010_000,
      progressPercent: 100,
      runtimeMetric: {
        name: "max_torque_apm",
        threshold: "1.005310e-4 T / 8.000000e1 A/m",
        value: "9.424778e-5 T / 7.500000e1 A/m",
      },
      status: "completed",
      stopReason: "torque",
    });
    expect(model.runtime.state).toBe("completed");
    expect(model.runtime.relaxTorqueStop?.status).toBe("93.8% of threshold");
  });

  it("projects runtime state-transfer metadata for a selected stage transition", () => {
    const snapshot = studySnapshotFromScene({
      study: {
        stages: [
          { kind: "relax", stage_id: "stage-relax" },
          { kind: "run", stage_id: "stage-run" },
        ],
      },
    } as never);

    const model = resolveStudyInspectorModel({
      commandQueue: null,
      currentRun: null,
      selectedStageRef: {
        nodeId: "model:study:stages:stage:stage-run:state-transition",
        stageId: "stage-run",
        stageIndex: 1,
      },
      snapshot,
      solverStatus: null,
      stageExecution: {
        active_stage_index: 1,
        active_stage_kind: "run",
        completed_stage_indexes: [0],
        revision: 16,
        runtime_state: "running",
        stage_statuses: ["completed", "running"],
        stages: [
          {
            index: 0,
            stage_id: "stage-relax",
            status: "completed",
          },
          {
            index: 1,
            stage_id: "stage-run",
            state_transfer_operator_kind: "identity_copy",
            state_transition: "Change device",
            state_transition_kind: "backend_transfer",
            state_transition_reason: "backend_change",
            state_transition_ui_presentation: "boundary_bar",
            status: "running",
          },
        ],
        total_stages: 2,
      } as never,
    });

    expect(model.selectedStage?.transition).toEqual({
      kind: "backend_transfer",
      label: "Change device",
      reason: "backend_change",
      transferOperator: "identity_copy",
      uiPresentation: "boundary_bar",
    });
  });

  it("prefers selected stage id over stale selected stage index", () => {
    const snapshot = studySnapshotFromScene({
      study: {
        stages: [
          { kind: "relax", stage_id: "relax-1" },
          { kind: "run", stage_id: "run-2" },
          { kind: "hysteresis", stage_id: "hysteresis-3" },
        ],
      },
    } as never);

    const model = resolveStudyInspectorModel({
      commandQueue: null,
      currentRun: null,
      selectedStageRef: {
        nodeId: "model:study:stages:stage:hysteresis-3:live-run",
        stageId: "hysteresis-3",
        stageIndex: 0,
      },
      snapshot,
      solverStatus: null,
      stageExecution: {
        active_stage_index: null,
        active_stage_kind: null,
        completed_stage_indexes: [],
        revision: 17,
        runtime_state: "idle",
        stage_statuses: ["idle", "idle"],
        stages: [
          { index: 0, stage_id: "relax-1", status: "idle" },
          { index: 1, stage_id: "run-2", status: "idle" },
        ],
        total_stages: 2,
      } as never,
    });

    expect(model.selectedStage).toMatchObject({
      index: 2,
      kind: "hysteresis",
      stageId: "hysteresis-3",
    });
  });

  it("resolves selected stage from a child node id when the selection ref is generic", () => {
    const snapshot = studySnapshotFromScene({
      study: {
        stages: [
          { kind: "relax", stage_id: "relax-1" },
          { kind: "run", stage_id: "run-2" },
          { kind: "hysteresis", stage_id: "hysteresis-3" },
        ],
      },
    } as never);

    const model = resolveStudyInspectorModel({
      commandQueue: null,
      currentRun: null,
      selectedNodeId: "model:study:stages:stage:hysteresis-3:live-run",
      selectedStageRef: {
        nodeId: "model:study:stages:stage:hysteresis-3:live-run",
      },
      snapshot,
      solverStatus: null,
      stageExecution: null,
    });

    expect(model.selectedStage).toMatchObject({
      index: 2,
      kind: "hysteresis",
      stageId: "hysteresis-3",
    });
  });

  it("uses solver pseudotime for active relax stages with pseudotime budgets", () => {
    const snapshot = studySnapshotFromScene({
      study: {
        stages: [
          {
            kind: "relax",
            max_pseudotime_s: "1e-5",
            relax_algorithm: "projected_gradient_bb",
            stage_id: "stage-relax",
          },
        ],
      },
    } as never);

    const model = resolveStudyInspectorModel({
      commandQueue: null,
      currentRun: null,
      selectedNodeId: "model:study:stages:stage:stage-relax",
      snapshot,
      solverStatus: {
        can_accept_commands: false,
        is_busy: true,
        pseudo_time_seconds: 8e-6,
        revision: 14,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        warnings: [],
      } as never,
      stageExecution: {
        active_stage_index: 0,
        active_stage_kind: "relax",
        completed_stage_indexes: [],
        revision: 15,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [{ stage_id: "stage-relax", status: "running" }],
        total_stages: 1,
      } as never,
    });

    expect(model.runtime.relaxTimeStop).toMatchObject({
      budget: "1.000000e-5 s",
      elapsed: "8.000000e-6 s",
      status: "80.0% of budget",
    });
  });
});
