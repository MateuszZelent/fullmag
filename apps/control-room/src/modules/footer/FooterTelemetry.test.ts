import { describe, expect, it } from "vitest";

import type {
  LiveStatusResource,
  ObjectMetricsResource,
  SceneResource,
  SolverStatusResource,
} from "@/kernel/api/apiTypes";

import {
  buildFooterTelemetryModel,
  footerTelemetryStatusEquals,
  resolvePrimaryTelemetryObjectId,
  selectFooterTelemetryStatus,
} from "./FooterTelemetry";

const status: LiveStatusResource = {
  api_contract_version: "1.0.0",
  capabilities: {
    algorithms_available: [],
    binary_fields: true,
    cell_fields: true,
    eigen_modes: false,
    explicit_topology: true,
    gpu_telemetry: true,
    node_fields: true,
    preview_2d: true,
    preview_3d: true,
    scalar_history: true,
    structured_grid: false,
  },
  display: {
    active_quantity_id: "m",
    auto_contrast: true,
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    field_component: "magnitude",
    max_points: 16384,
    slice_layer: 0,
    slice_mode: "single",
    vector_density: 50,
    vector_glyphs: true,
    view_mode: "3d",
    x_chosen_size: 0,
    y_chosen_size: 0,
  },
  domain: {
    cell_count: 1024,
    discretization: "fem",
    generation_id: 7,
  },
  energies: {
    anisotropy: 0.4,
    demag: 0.2,
    dmi: 0.5,
    exchange: 0.1,
    total: 1.5,
    zeeman: 0.3,
  },
  metrics: {
    steps_per_second: 4.2,
    total_steps: 12,
    uptime_seconds: 60,
  },
  resources: {
    artifact_revision: 0,
    artifacts_revision: 0,
    command_completion_revision: 0,
    commands_revision: 0,
    display_revision: 1,
    domain_generation_id: 7,
    engine_log_revision: 0,
    field_catalog_revision: 0,
    field_revision: 0,
    fields_revision: 0,
    mesh_build_revision: 0,
    mesh_revision: 0,
    scalars_revision: 22,
    scene_revision: 2,
    slice_revision: 0,
    solver_profile_revision: 0,
    stages_revision: 0,
    topology_revision: 0,
    visualization_state_revision: 1,
    workspace_revision: 0,
  },
  run: {
    run_id: "run-1",
    solver_steps: 12,
    solver_time: 3601,
    stage_count: 1,
    stage_index: 0,
    stage_label: "relax",
    started_at: "0",
  },
  runtime_bundle_version: "test",
  session: {
    created_at: "0",
    name: "test",
    session_id: "session-1",
    workspace_root: "/tmp/fullmag",
  },
  solver: {
    algorithm: null,
    converged: false,
    dt: 1e-12,
    max_torque_T: 0.006,
    state: "running",
  },
};

function solverStatusFixture(
  value: SolverStatusResource & { active_runtime_seconds?: number | null },
): SolverStatusResource {
  return value;
}

const objectMetrics: ObjectMetricsResource = {
  energies: {
    anisotropy: 4,
    demag: 2,
    dmi: 5,
    exchange: 1,
    total: 15,
    zeeman: 3,
  },
  has_solver_sample: true,
  magnetization_average: {
    mx: 0.25,
    my: -0.5,
    mz: 0.75,
  },
  object_id: "arch_waveguide",
  revision: 22,
  source: "solver",
  step: 99,
  time_seconds: 1.25e-9,
};

describe("FooterTelemetry", () => {
  it("builds a responsive metric model from live status and object metrics", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, objectMetrics);
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(model.statusTitle).toBe("System Status: Running");
    expect(byId["avg-mx"]?.value).toBe("0.250000");
    expect(byId["avg-my"]?.value).toBe("-0.500000");
    expect(byId["avg-mz"]?.value).toBe("0.750000");
    expect(byId["energy-total"]?.value).toBe("15");
    expect(byId["max-torque"]?.value).toBe("6.000000e-3 T");
    expect(byId.step?.value).toBe("99");
  });

  it("uses detailed runtime state for the visible compute status", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, null, solverStatusFixture({
      algorithm: null,
      can_accept_commands: true,
      converged: false,
      dt_seconds: 0,
      integrator: null,
      is_busy: false,
      last_error: null,
      max_torque_T: 0,
      active_runtime_seconds: null,
      pseudo_time_seconds: null,
      revision: 4,
      run_id: status.run?.run_id ?? null,
      runtime_state: "waiting_for_compute",
      runtime_status_code: "waiting_for_compute",
      runtime_status_kind: "ready",
      session_status: "running",
      sim_time_seconds: 0,
      stage_kind: "relax",
      step_index: 0,
      warnings: [],
    }));

    const dt = model.metrics.find((metric) => metric.id === "dt");
    expect(model.statusTitle).toBe("System Status: Waiting for compute");
    expect(model.onlineTitle).toBe("Online / Waiting");
    expect(model.statusState).toBe("waiting_for_compute");
    expect(dt?.subdetail).toBe("State: Waiting for compute");
  });

  it("shows physical simulation time when pseudotime is absent", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, null, solverStatusFixture({
      algorithm: "llg_overdamped",
      can_accept_commands: false,
      converged: false,
      dt_seconds: 1e-13,
      integrator: "rk23",
      is_busy: true,
      last_error: null,
      max_torque_T: 0.002,
      active_runtime_seconds: 0.25,
      pseudo_time_seconds: null,
      revision: 5,
      run_id: status.run?.run_id ?? null,
      runtime_state: "running",
      runtime_status_code: "running",
      runtime_status_kind: "running",
      session_status: "running",
      sim_time_seconds: 4e-9,
      stage_kind: "relax",
      step_index: 42,
      warnings: [],
    }));
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId.time?.label).toBe("Sim time");
    expect(byId.time?.detail).toBe("Physical simulation time");
    expect(byId["sim-time"]).toBeUndefined();
    expect(byId["active-runtime"]?.label).toBe("Runtime");
    expect(byId["active-runtime"]?.detail).toBe("Active compute time");
  });

  it("uses live scalar samples for fast footer telemetry values", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, objectMetrics, null, {
      revision: 24,
      row: {
        e_ani: 0.9,
        e_demag: 0.7,
        e_dmi: 1.1,
        e_ex: 0.6,
        e_ext: 0.8,
        e_total: 3.1,
        max_torque_T: 0.004,
        mx: 0.1,
        my: 0.2,
        mz: 0.3,
        solver_dt: 2e-12,
        step: 123,
        time: 2.5,
      },
      runId: "run-1",
      sessionId: "session-1",
      step: 123,
      time: 2.5,
    });
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId.step?.value).toBe("123");
    expect(byId.step?.subdetail).toBe("t=2.5 s");
    expect(byId["avg-mx"]?.value).toBe("0.100000");
    expect(byId["avg-my"]?.value).toBe("0.200000");
    expect(byId["avg-mz"]?.value).toBe("0.300000");
    expect(byId["avg-mx"]?.subdetail).toBe("Live scalar sample");
    expect(byId["energy-total"]?.value).toBe("3.1");
    expect(byId["energy-total"]?.subdetail).toBe("Live scalar sample");
    expect(byId["max-torque"]?.value).toBe("4.000000e-3 T");
  });

  it("shows pseudotime and keeps physical simulation time separate for direct minimizers", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(
      telemetryStatus,
      objectMetrics,
      solverStatusFixture({
        algorithm: "projected_gradient_bb",
        can_accept_commands: false,
        converged: false,
        dt_seconds: 2e-6,
        integrator: null,
        is_busy: true,
        last_error: null,
        max_torque_T: 0.004,
        active_runtime_seconds: 0.12,
        pseudo_time_seconds: 8e-6,
        revision: 6,
        run_id: status.run?.run_id ?? null,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        stage_kind: "relax",
        step_index: 8,
        warnings: [],
      }),
      {
        revision: 26,
        row: {
          active_runtime_s: 0.2,
          pseudo_time_s: 9e-6,
          step: 9,
          time: 0,
        },
        runId: "run-1",
        sessionId: "session-1",
        step: 9,
        time: 0,
      },
    );
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId.time?.label).toBe("Pseudo time");
    expect(byId.time?.detail).toBe("Direct minimizer pseudotime");
    expect(byId["sim-time"]?.label).toBe("Sim time");
    expect(byId["sim-time"]?.detail).toBe("Physical simulation time");
    expect(byId["active-runtime"]?.label).toBe("Runtime");
    expect(byId["active-runtime"]?.value).toBe("00h 00m 00s");
    expect(byId.dt?.label).toBe("Pseudo dt");
    expect(byId.dt?.detail).toBe("Minimizer pseudotime step");
    expect(byId.step?.subdetail).toBe("t=0.000000e+0 s");
  });

  it("ignores stale live scalar samples from a previous run", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: {
        ...status,
        run: {
          ...status.run!,
          run_id: "run-2",
        },
      },
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, null, null, {
      revision: 26,
      row: {
        pseudo_time_s: 9e-6,
        step: 9,
        time: 0,
      },
      runId: "run-1",
      sessionId: "session-1",
      step: 9,
      time: 0,
    });
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId.time?.label).toBe("Sim time");
    expect(byId["sim-time"]).toBeUndefined();
    expect(byId.dt?.label).toBe("dt");
  });

  it("selects only telemetry-relevant status fields", () => {
    const selected = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const sameTelemetry = selectFooterTelemetryStatus({
      data: {
        ...status,
        resources: {
          ...status.resources,
          artifact_revision: 99,
          field_revision: 88,
          topology_revision: 77,
        },
      },
      error: null,
      refetch: () => {},
      revision: 2,
      status: "ready",
    });
    const nextTelemetry = selectFooterTelemetryStatus({
      data: {
        ...status,
        solver: {
          ...status.solver,
          max_torque_T: 0.008,
        },
      },
      error: null,
      refetch: () => {},
      revision: 3,
      status: "ready",
    });

    expect(selected).not.toBe(status);
    expect(footerTelemetryStatusEquals(selected, sameTelemetry)).toBe(true);
    expect(footerTelemetryStatusEquals(selected, nextTelemetry)).toBe(false);
  });

  it("uses the selected scene object as the telemetry object source", () => {
    const scene = {
      objects: [
        { id: "arch_waveguide", name: "Arch waveguide" },
        { id: "free_layer", name: "Free layer" },
      ],
      revision: 2,
    } satisfies SceneResource;

    expect(resolvePrimaryTelemetryObjectId(scene, "free_layer")).toBe("free_layer");
    expect(resolvePrimaryTelemetryObjectId(scene)).toBe("arch_waveguide");
    expect(resolvePrimaryTelemetryObjectId(scene, "missing")).toBe("arch_waveguide");
    expect(resolvePrimaryTelemetryObjectId({ objects: [], revision: 3 })).toBeNull();
  });
});
