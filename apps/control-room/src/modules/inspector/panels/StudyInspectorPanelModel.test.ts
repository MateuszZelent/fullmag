import { describe, expect, it } from "vitest";

import {
  resolveStudyInspectorModel,
  studySnapshotFromScene,
} from "./StudyInspectorPanelModel";

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
            torque_tolerance: "1e-4",
          },
          {
            entrypoint_kind: "run",
            kind: "run",
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
      selectedNodeId: "model:study:stage:0",
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
        stages: [{ status: "running" }, { status: "queued" }],
        total_stages: 2,
      } as never,
    });

    expect(model.selectedStage).toMatchObject({
      energyTolerance: "1e-8",
      index: 0,
      kind: "relax",
      label: "Relax 1",
      maxSteps: "200",
      progressPercent: 25,
      status: "running",
      torqueTolerance: "1e-4",
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
      maxTorque: "3.000e-3 T",
      progressPercent: 25,
      runId: "run-1",
      state: "running",
    });
  });
});
