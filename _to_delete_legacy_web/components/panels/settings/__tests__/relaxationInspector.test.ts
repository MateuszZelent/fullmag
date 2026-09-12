import { describe, expect, it } from "vitest";

import type { ScalarRow, StageExecutionRecord } from "@/lib/session/types";

import { buildRelaxationInspectorState } from "../relaxationInspector";

function row(overrides: Partial<ScalarRow>): ScalarRow {
  return {
    step: 0,
    time: 0,
    solver_dt: 1e-13,
    mx: 0,
    my: 0,
    mz: 1,
    e_ex: 0,
    e_demag: 0,
    e_ext: 0,
    e_ani: 0,
    e_dmi: 0,
    e_total: 0,
    max_dm_dt: 0,
    max_h_eff: 0,
    max_h_demag: 0,
    max_torque_Apm: 0,
    max_torque_T: 0,
    ...overrides,
  };
}

describe("buildRelaxationInspectorState", () => {
  it("uses the tighter convergence criterion as overall live progress", () => {
    const state = buildRelaxationInspectorState({
      payload: {
        torque_tolerance: "1e-4",
        energy_tolerance: "1e-12",
      },
      stageExecutionRecord: null,
      stageStatus: "running",
      scalarRows: [
        row({ step: 9, time: 9e-10, e_total: 3e-12, max_torque_Apm: 1e-3 }),
        row({ step: 10, time: 1e-9, e_total: 2e-12, max_torque_Apm: 2e-4 }),
      ],
    });

    expect(state.overviewLabel).toBe("Convergence");
    expect(state.overviewValue).toBe("50% ready");
    expect(state.overviewAuxValue).toBe("2.000e-4 A/m / 1.000e-4 A/m");
    expect(state.overviewDetail).toContain("Max torque 2.000e-4 A/m / 1.000e-4 A/m.");
    expect(state.overviewProgress).toBeCloseTo(50);
    expect(state.metrics.map((metric) => metric.key)).toEqual(["torque", "energy"]);
  });

  it("reports the runtime stop reason once the stage completed", () => {
    const record: StageExecutionRecord = {
      status: "completed",
      reason: "energy",
      metric_name: "energy_delta_j",
      metric_value: 9e-13,
      threshold: 1e-12,
    };

    const state = buildRelaxationInspectorState({
      payload: {
        energy_tolerance: "1e-12",
      },
      stageExecutionRecord: record,
      stageStatus: "completed",
      scalarRows: [
        row({ step: 100, time: 1e-9, e_total: 2e-12 }),
        row({ step: 101, time: 1.01e-9, e_total: 1.1e-12 }),
      ],
    });

    expect(state.overviewLabel).toBe("Final stop");
    expect(state.overviewValue).toBe("Stopped by energy delta threshold");
    expect(state.overviewAuxValue).toBeNull();
    expect(state.overviewProgress).toBe(100);
    expect(state.lastStopDetail).toContain("energy_delta_j");
  });

  it("falls back to budget-only semantics when no convergence threshold is configured", () => {
    const state = buildRelaxationInspectorState({
      payload: {
        max_steps: "5000",
      },
      stageExecutionRecord: null,
      stageStatus: "running",
      scalarRows: [row({ step: 1250, time: 5e-10 })],
    });

    expect(state.semantics).toContain("Only hard budgets can stop the relaxation");
    expect(state.metrics).toHaveLength(1);
    expect(state.metrics[0]).toMatchObject({
      key: "max_steps",
      progress: 25,
    });
  });

  it("falls back to live telemetry when the latest scalar row has no torque yet", () => {
    const state = buildRelaxationInspectorState({
      payload: {
        torque_tolerance: "1e-4",
        max_steps: "50000",
      },
      stageExecutionRecord: null,
      stageStatus: "running",
      scalarRows: [row({ step: 11, time: 1.1e-9, max_torque_Apm: undefined, max_torque_T: undefined })],
      liveState: {
        status: "running",
        updated_at_unix_ms: 0,
        step: 11,
        time: 1.1e-9,
        dt: 1e-13,
        e_ex: 0,
        e_demag: 0,
        e_ext: 0,
        e_ani: 0,
        e_dmi: 0,
        e_total: 0,
        max_dm_dt: 0,
        max_h_eff: 0,
        max_h_demag: 0,
        max_torque_Apm: 2e-4,
        max_torque_T: 2e-4,
        wall_time_ns: 0,
        grid: [0, 0, 0],
        preview_grid: null,
        preview_data_points_count: null,
        preview_max_points: null,
        preview_auto_downscaled: false,
        preview_auto_downscale_message: null,
        fem_mesh: null,
        magnetization: null,
        finished: false,
      },
    });

    expect(state.overviewValue).toBe("50% ready");
    expect(state.overviewAuxValue).toBe("2.000e-4 A/m / 1.000e-4 A/m");
    expect(state.metrics[0]).toMatchObject({
      key: "torque",
      value: "2.000e-4 A/m / 1.000e-4 A/m",
      progress: 50,
    });
  });

  it("explains that stop records appear after the stage exits", () => {
    const state = buildRelaxationInspectorState({
      payload: {
        torque_tolerance: "1e-4",
      },
      stageExecutionRecord: null,
      stageStatus: "running",
      scalarRows: [],
    });

    expect(state.lastStopDetail).toBe("Runtime publishes the stop record only after this stage exits.");
  });
});
