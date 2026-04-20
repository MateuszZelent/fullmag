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
          field_revision: 7,
          source_step: 7,
          source_time: 1.5e-12,
        },
      },
      step_update_v2: {
        diagnostics: {
          step: 12,
          time: 3.5e-12,
        },
        scalars: {},
        frames: [
          {
            quantity_id: "m",
            unit: "dimensionless",
            n_comp: 3,
            grid: [2, 1, 1],
            values: [1, 0, 0, 0, 1, 0],
            active_mask: [true, true],
            field_revision: 12,
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
    expect(state.latest_fields.frames.eden_total.field_revision).toBe(7);
    expect(state.latest_fields.frames.eden_total.source_step).toBe(7);
    expect(state.latest_fields.frames.eden_total.source_time).toBe(1.5e-12);
    expect(state.latest_fields.frames.m.unit).toBe("dimensionless");
    expect(state.latest_fields.frames.m.n_comp).toBe(3);
    expect(Array.from(state.latest_fields.frames.m.values)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(state.latest_fields.frames.m.field_revision).toBe(12);
    expect(state.latest_fields.frames.m.source_step).toBe(12);
    expect(state.latest_fields.frames.m.source_time).toBe(3.5e-12);
  });

  it("keeps latest_fields frame metadata even when values are omitted for binary transport", () => {
    const state = normalizeSessionState({
      session: {
        session_id: "sess-2",
        run_id: "run-2",
        status: "running",
        interactive_session_requested: false,
        script_path: "",
        problem_name: "test",
        requested_backend: "fem",
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
        m: {
          unit: "dimensionless",
          n_comp: 3,
          grid: [4, 1, 1],
          domain: "magnetic_only",
          field_revision: 44,
          source_step: 44,
          source_time: 9.0e-12,
          transport: "binary",
        },
      },
    });

    expect(state.latest_fields.grid).toEqual([4, 1, 1]);
    expect(state.latest_fields.frames.m.unit).toBe("dimensionless");
    expect(state.latest_fields.frames.m.n_comp).toBe(3);
    expect(state.latest_fields.frames.m.grid).toEqual([4, 1, 1]);
    expect(state.latest_fields.frames.m.values.length).toBe(0);
    expect(state.latest_fields.frames.m.field_revision).toBe(44);
    expect(state.latest_fields.frames.m.source_step).toBe(44);
    expect(state.latest_fields.frames.m.source_time).toBe(9.0e-12);
  });

  it("hydrates latest_fields.m from live_state magnetization when bootstrap has no field frames yet", () => {
    const state = normalizeSessionState({
      session: {
        session_id: "sess-2b",
        run_id: "run-2b",
        status: "running",
        interactive_session_requested: false,
        script_path: "",
        problem_name: "test",
        requested_backend: "fem",
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
      live_state: {
        status: "running",
        updated_at_unix_ms: 123,
        latest_step: {
          step: 11,
          time: 4.5e-12,
          grid: [0, 0, 0],
          magnetization: [1, 0, 0, 0, 1, 0],
        },
      },
      latest_fields: {},
    });

    expect(state.live_state?.magnetization).toBeInstanceOf(Float64Array);
    expect(state.latest_fields.grid).toEqual([2, 1, 1]);
    expect(state.latest_fields.frames.m.unit).toBe("dimensionless");
    expect(state.latest_fields.frames.m.n_comp).toBe(3);
    expect(Array.from(state.latest_fields.frames.m.values)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(state.latest_fields.frames.m.domain).toBe("magnetic_only");
    expect(state.latest_fields.frames.m.field_revision).toBe(11);
    expect(state.latest_fields.frames.m.source_step).toBe(11);
    expect(state.latest_fields.frames.m.source_time).toBe(4.5e-12);
  });

  it("keeps fem_mesh metadata even when topology arrays are omitted for binary transport", () => {
    const state = normalizeSessionState({
      session: {
        session_id: "sess-3",
        run_id: "run-3",
        status: "running",
        interactive_session_requested: false,
        script_path: "",
        problem_name: "test",
        requested_backend: "fem",
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
      fem_mesh: {
        mesh_name: "solver-mesh",
        mesh_id: "mesh-1",
        generation_id: "gen-1",
        mesh_parts: [],
        object_segments: [],
        node_count: 1200,
        element_count: 640,
        boundary_face_count: 320,
        transport: "binary",
      },
    });

    expect(state.fem_mesh?.mesh_name).toBe("solver-mesh");
    expect(state.fem_mesh?.mesh_id).toBe("mesh-1");
    expect(state.fem_mesh?.generation_id).toBe("gen-1");
    expect(state.fem_mesh?.topology_transport).toBe("binary");
    expect(state.fem_mesh?.node_count).toBe(1200);
    expect(state.fem_mesh?.element_count).toBe(640);
    expect(state.fem_mesh?.boundary_face_count).toBe(320);
    expect(state.fem_mesh?.nodes.length).toBe(0);
    expect(state.fem_mesh?.elements.length).toBe(0);
    expect(state.fem_mesh?.boundary_faces.length).toBe(0);
  });
});
