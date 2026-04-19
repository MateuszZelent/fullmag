import { describe, expect, it } from "vitest";

import type { ScalarRow, SessionState } from "../types";
import { mergeScalarRowsDelta, mergeSessionState } from "../merge";

function row(step: number, overrides: Partial<ScalarRow> = {}): ScalarRow {
  return {
    step,
    time: step * 1e-12,
    solver_dt: 1e-14,
    mx: 0,
    my: 0,
    mz: 1,
    e_ex: step,
    e_demag: step,
    e_ext: step,
    e_ani: 0,
    e_dmi: 0,
    e_total: step,
    max_dm_dt: step + 0.5,
    max_h_eff: step + 1,
    max_h_demag: 0,
    max_torque_Apm: 0,
    max_torque_T: 0,
    ...overrides,
  };
}

describe("mergeScalarRowsDelta", () => {
  it("appends pure delta rows", () => {
    const merged = mergeScalarRowsDelta(
      [row(1), row(2)],
      [row(3), row(4)],
      4,
      null,
    );

    expect(merged.map((entry) => entry.step)).toEqual([1, 2, 3, 4]);
  });

  it("replaces the live tip when the same step arrives again", () => {
    const merged = mergeScalarRowsDelta(
      [row(1), row(2, { e_total: 2, max_dm_dt: 2.5 })],
      [row(2, { e_total: 20, max_dm_dt: 200.5 })],
      2,
      null,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]?.step).toBe(2);
    expect(merged[1]?.e_total).toBe(20);
    expect(merged[1]?.max_dm_dt).toBe(200.5);
  });

  it("replaces the overlapping tip and appends new rows", () => {
    const merged = mergeScalarRowsDelta(
      [row(1), row(2, { e_total: 2 })],
      [row(2, { e_total: 22 }), row(3, { e_total: 33 })],
      3,
      null,
    );

    expect(merged.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(merged[1]?.e_total).toBe(22);
    expect(merged[2]?.e_total).toBe(33);
  });

  it("keeps the full history when the caller opts out of the live cap", () => {
    const prevRows = Array.from({ length: 10_000 }, (_, index) => row(index));
    const nextRows = [row(10_000)];

    const merged = mergeScalarRowsDelta(prevRows, nextRows, 10_001, null);

    expect(merged).toHaveLength(10_001);
    expect(merged[0]?.step).toBe(0);
    expect(merged[10_000]?.step).toBe(10_000);
  });
});

function makeSessionState(args: {
  sceneRevision: number;
  latestMagnetization?: number[];
  liveMagnetization?: number[];
}): SessionState {
  const latestMagnetizationValues =
    args.latestMagnetization != null ? new Float64Array(args.latestMagnetization) : null;
  const liveMagnetizationValues =
    args.liveMagnetization != null ? new Float64Array(args.liveMagnetization) : null;

  return {
    session: {
      session_id: "sess-1",
      run_id: "run-1",
      status: "waiting",
      interactive_session_requested: true,
      script_path: "/tmp/test.py",
      problem_name: "merge-test",
      requested_backend: "fem",
      explicit_selection: true,
      requested_device: "cpu",
      requested_precision: "double",
      requested_mode: "strict",
      execution_mode: "strict",
      precision: "double",
      artifact_dir: "/tmp",
      started_at_unix_ms: 0,
      finished_at_unix_ms: 0,
      plan_summary: {},
    },
    run: null,
    live_state: {
      status: "waiting",
      updated_at_unix_ms: 100,
      step: 0,
      time: 0,
      dt: 0,
      e_ex: 0,
      e_demag: 0,
      e_ext: 0,
      e_ani: 0,
      e_dmi: 0,
      e_total: 0,
      max_dm_dt: 0,
      max_h_eff: 0,
      max_h_demag: 0,
      wall_time_ns: 0,
      grid: [1, 1, 1],
      preview_grid: null,
      preview_data_points_count: null,
      preview_max_points: null,
      preview_auto_downscaled: false,
      preview_auto_downscale_message: null,
      fem_mesh: null,
      magnetization: liveMagnetizationValues,
      finished: false,
    },
    runtime_status: null,
    capabilities: null,
    metadata: null,
    mesh_workspace: null,
    stage_execution: null,
    scene_document: { revision: args.sceneRevision } as any,
    script_builder: null,
    model_builder_graph: null,
    scalar_rows: [],
    scalar_rows_total: 0,
    engine_log: [],
    quantities: [],
    fem_mesh: null,
    latest_fields: {
      frames:
        latestMagnetizationValues != null
          ? {
              m: {
                quantity_id: "m",
                unit: "dimensionless",
                n_comp: 3,
                grid: [latestMagnetizationValues.length / 3, 1, 1],
                values: latestMagnetizationValues,
                active_mask: null,
                location: "node",
                domain: "magnetic_only",
              },
            }
          : {},
      grid: latestMagnetizationValues != null ? [latestMagnetizationValues.length / 3, 1, 1] : null,
    },
    artifacts: [],
    display_selection: null,
    preview_config: null,
    preview: null,
    command_status: null,
    step_update_v2: null,
  };
}

describe("mergeSessionState", () => {
  it("refreshes latest magnetization frame from live_state when scene revision advances", () => {
    const prev = makeSessionState({
      sceneRevision: 2,
      latestMagnetization: [1, 0, 0, 0, 1, 0],
      liveMagnetization: [1, 0, 0, 0, 1, 0],
    });
    const next = makeSessionState({
      sceneRevision: 3,
      latestMagnetization: undefined,
      liveMagnetization: [0, 0, 1, 0, 0, 1],
    });

    const merged = mergeSessionState(prev, next);

    expect(Array.from(merged.latest_fields.frames.m?.values ?? [])).toEqual([
      0, 0, 1, 0, 0, 1,
    ]);
    expect(merged.latest_fields.frames.m?.values).toBe(merged.live_state?.magnetization);
    expect(merged.latest_fields.frames.m?.domain).toBe("magnetic_only");
  });
});
