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
        demag_realization: "poisson_robin",
        external_field: [0.01, 0, -0.002],
        requested_backend: "fem",
        requested_device: "gpu",
        requested_mode: "strict",
        requested_precision: "double",
        stages: [
          {
            energy_tolerance: "1e-8",
            entrypoint_kind: "relax",
            kind: "relax",
            max_steps: "200",
            relax_algorithm: "llg_overdamped",
            torque_tolerance: TORQUE_TOLERANCE_FOR_1E_4_T,
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
      selectedNodeId: "model:study:stage:runtime-run",
      snapshot,
      solverStatus: {
        can_accept_commands: true,
        is_busy: true,
        max_torque: 0.003,
        revision: 4,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        step_index: 50,
        warnings: [],
      } as never,
      stageExecution: {
        active_stage_index: 0,
        active_stage_kind: "relax",
        completed_stage_indexes: [],
        revision: 5,
        runtime_state: "running",
        stage_statuses: ["running", "queued"],
        stages: [
          { stage_id: "runtime-relax", status: "running" },
          { stage_id: "runtime-run", status: "queued" },
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
      status: "queued",
      untilSeconds: "5e-9",
    });
    expect(model.boundary).toEqual({
      demagRealization: "poisson_robin",
      externalField: "0.01, 0, -0.002 T",
    });
    expect(model.requested).toEqual({
      backend: "fem",
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
      maxTorque: "3.000e-3 T",
      progressPercent: 25,
      relaxTorqueStop: {
        current: "3.000e-3 T / 2.387e3 A/m",
        status: "30.0x above threshold",
        threshold: "1.000e-4 T / 7.958e1 A/m",
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
});
