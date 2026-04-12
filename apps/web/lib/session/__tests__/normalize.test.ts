import { describe, expect, it } from "vitest";

import { normalizeSessionState } from "../normalize";

describe("normalizeSessionState", () => {
  it("keeps typed latest_fields metadata for scalar and vector frames", () => {
    const state = normalizeSessionState({
      session: {
        session_id: "sess-1",
        run_id: "run-1",
        status: "running",
        interactive_session_requested: false,
        script_path: "",
        problem_name: "test",
        requested_backend: "fdm",
        explicit_selection: false,
        requested_device: "auto",
        requested_precision: "double",
        requested_mode: "strict",
        execution_mode: "strict",
        precision: "double",
        artifact_dir: "",
        started_at_unix_ms: 0,
        finished_at_unix_ms: 0,
        plan_summary: {},
      },
      latest_fields: {
        eden_total: {
          unit: "J/m^3",
          n_comp: 1,
          grid: [2, 1, 1],
          values: [1, 2],
          active_mask: [true, false],
          location: "cell",
          domain: "magnetic_only",
        },
      },
      step_update_v2: {
        diagnostics: {},
        scalars: {},
        frames: [
          {
            quantity_id: "m",
            unit: "dimensionless",
            n_comp: 3,
            grid: [2, 1, 1],
            values: [1, 0, 0, 0, 1, 0],
            active_mask: [true, true],
          },
        ],
        finished: false,
      },
    });

    expect(state.latest_fields.grid).toEqual([2, 1, 1]);
    expect(state.latest_fields.frames.eden_total.unit).toBe("J/m^3");
    expect(state.latest_fields.frames.eden_total.n_comp).toBe(1);
    expect(Array.from(state.latest_fields.frames.eden_total.values)).toEqual([1, 2]);
    expect(Array.from(state.latest_fields.frames.eden_total.active_mask ?? [])).toEqual([1, 0]);
    expect(state.latest_fields.frames.m.unit).toBe("dimensionless");
    expect(state.latest_fields.frames.m.n_comp).toBe(3);
    expect(Array.from(state.latest_fields.frames.m.values)).toEqual([1, 0, 0, 0, 1, 0]);
  });
});
