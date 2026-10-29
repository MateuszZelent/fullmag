import { describe, expect, it } from "vitest";

import type {
  FrequencyDomainSweepProgressResource,
  LiveStatusResource,
  ObjectMetricsResource,
  SceneResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import { activeLaneCapabilityFixture } from "@/kernel/resources/activeLaneCapabilityFixture.testSupport";

import {
  buildFooterTelemetryModel,
  footerTelemetryStatusEquals,
  resolveFooterMagneticModelPresent,
  resolvePrimaryTelemetryObjectId,
  selectFooterTelemetryStatus,
} from "./FooterTelemetry";

const status: LiveStatusResource = {
  api_contract_version: "1.0.0",
  capabilities: {
    active_lane: activeLaneCapabilityFixture(),
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
    generation_id: "7",
  },
  lifecycle: {
    solver: "awaiting_command",
    session_resource: "active",
    connectivity: "connected",
    commandability: "allowed",
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
    domain_generation_id: "7",
    engine_log_revision: 0,
    field_catalog_revision: 0,
    field_revision: 0,
    fields_revision: 0,
    mesh_build_revision: 0,
    mesh_revision: 0,
    mode_composition_revision: 0,
    region_coefficients_revision: 0,
    region_initial_state_revision: 0,
    region_membership_revision: 0,
    region_topology_revision: 0,
    scalars_revision: 22,
    scene_revision: 2,
    simulation_preparation_revision: 0,
    slice_revision: 0,
    solver_profile_revision: 0,
    stages_revision: 0,
    topology_revision: 0,
    visualization_state_revision: 1,
    workspace_revision: 0,
  },
  run: {
    calibration_id: "rtx4080-qualified-v1",
    requested_device: "auto",
    resolved_device: "gpu",
    run_id: "run-1",
    selection_confidence: 0.94,
    selection_reason: "calibrated_above_upper_bound",
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
    session_epoch: "session-1@0",
    request_scope_epoch: "test-api:0",
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
  source: "solver_per_object",
  step: 99,
  time_seconds: 1.25e-9,
};

describe("FooterTelemetry", () => {
  const currentStatus = selectFooterTelemetryStatus({
    data: status, error: null, refetch: () => {}, revision: 1, status: "ready",
  });


  const antennaProgress = {
    phase: "evaluating_field" as const,
    completed_targets: 1_000, total_targets: 2_000,
    source_cells: 1_856, elapsed_seconds: 61,
  };
  function antennaExecution(progress: unknown = antennaProgress, state = "running"): StageExecutionResource {
    return {
      session_id: status.session.session_id,
      session_epoch: status.session.session_epoch,
      request_scope_epoch: status.session.request_scope_epoch,
      run_id: status.run!.run_id,
      runtime_state: state,
      active_stage_index: 0,
      stages: [{
        index: 0, stage_id: "authored-stage", antenna_solve_stage_id: "solve-loop",
        status: state, antenna_progress: progress,
      }],
    } as StageExecutionResource;
  }
  const antennaModel = (execution = antennaExecution()) =>
    buildFooterTelemetryModel(currentStatus, null, null, null, execution);
  const antennaMetric = (model: ReturnType<typeof antennaModel>, id: string) =>
    model.metrics.find((metric) => metric.id === id)?.value;

  it("uses field samples as bounded numerical progress without LLG metrics", () => {
    const model = antennaModel();
    expect(model.antennaProgress).toEqual({ active: true, percent: 50, samples: "1,000 / 2,000" });
    expect(antennaMetric(model, "antenna-phase")).toBe("Evaluating Oersted field");
    expect(antennaMetric(model, "antenna-source")).toBe("1,856");
    expect(antennaMetric(model, "antenna-elapsed")).toBe("1m 01.000s");
    expect(model.metrics.some((metric) => ["step", "time", "dt", "avg-m", "energy-total"].includes(metric.id))).toBe(false);
  });

  it.each([
    null,
    { ...antennaProgress, phase: "future_phase" },
    { ...antennaProgress, completed_targets: Number.NaN },
    { ...antennaProgress, completed_targets: -1 },
    { ...antennaProgress, completed_targets: 0.5 },
    { ...antennaProgress, completed_targets: 2_001 },
    { ...antennaProgress, total_targets: 0 },
    { ...antennaProgress, source_cells: 0 },
    { ...antennaProgress, phase: "preparing_source" },
    { ...antennaProgress, phase: "publishing_result" },
    { ...antennaProgress, source_cells: Number.POSITIVE_INFINITY },
    { ...antennaProgress, source_cells: Number.MAX_SAFE_INTEGER + 1 },
    { ...antennaProgress, elapsed_seconds: -1 },
  ])("does not invent a field percentage or phase for absent/invalid progress: %j", (progress) => {
    const model = antennaModel(antennaExecution(progress));
    expect(model.antennaProgress?.percent).toBeNull();
    expect(antennaMetric(model, "antenna-targets")).toBe("Progress not reported");
    expect(antennaMetric(model, "antenna-phase")).toBe("Progress not reported");
  });

  it("distinguishes operation elapsed from the earlier stage journal clock", () => {
    const execution = antennaExecution();
    execution.stages[0].started_at_unix_ms = 1_000;
    execution.stages[0].completed_at_unix_ms = null;
    const numerical = buildFooterTelemetryModel(currentStatus, null, null, null,
      execution, null, null, null, { nowMs: 121_000 });
    const operationMetric = numerical.metrics.find((metric) => metric.id === "antenna-elapsed");
    expect(operationMetric?.label).toBe("Operation elapsed");
    expect(operationMetric?.value).toBe("1m 01.000s");
    expect(operationMetric?.detail).toContain("operation runner started");
    execution.stages[0].antenna_progress = undefined;
    const legacy = buildFooterTelemetryModel(currentStatus, null, null, null,
      execution, null, null, null, { nowMs: 121_000 });
    const stageMetric = legacy.metrics.find((metric) => metric.id === "antenna-elapsed");
    expect(stageMetric?.label).toBe("Stage elapsed");
    expect(stageMetric?.value).toBe("2m 00.000s");
    expect(stageMetric?.detail).toContain("published stage timestamps");
  });

  it("does not imply field progress during the source solve", () => {
    const model = antennaModel(antennaExecution({
      ...antennaProgress, phase: "solving_potential", completed_targets: 0,
    }));
    expect(model.antennaProgress?.percent).toBeNull();
    expect(antennaMetric(model, "antenna-phase")).toBe("Solving electric potential");
  });

  it("does not animate a running record when the enclosing runtime is terminal", () => {
    const execution = antennaExecution();
    execution.runtime_state = "failed";
    expect(antennaModel(execution).antennaProgress?.active).toBe(false);
  });

  it("keeps publication failure visible after all field targets were evaluated", () => {
    const execution = antennaExecution({
      ...antennaProgress, phase: "publishing_result", completed_targets: 2_000,
    }, "failed");
    execution.stages[0].state_transition_reason = "Result store is locked";
    const model = antennaModel(execution);
    expect(model.antennaProgress?.percent).toBe(100);
    expect(model.antennaProgress?.active).toBe(false);
    expect(model.statusTitle).toContain("Failed");
    expect(model.statusDetail).toBe("Result store is locked");
    expect(antennaMetric(model, "antenna-results")).toBe("Not completed");
  });

  it.each(["session_id", "session_epoch", "request_scope_epoch", "run_id"] as const)(
    "rejects stale antenna progress from a foreign %s", (key) => {
      const execution = antennaExecution();
      execution[key] = "foreign";
      expect(antennaModel(execution).antennaProgress).toBeNull();
    },
  );

  it.each(["pending", "completed", "failed", "cancelled"])(
    "does not animate a non-running antenna stage: %s", (state) => {
      expect(antennaModel(antennaExecution(null, state)).antennaProgress?.active).toBe(false);
    },
  );

  it("does not publish fabricated metrics without current session telemetry", () => {
    const model = buildFooterTelemetryModel(null, objectMetrics);
    expect(model.metrics).toEqual([]);
    expect(model.statusTitle).toBe("System Status: No live telemetry");
    expect(model.awaitingCompute).toBe(false);
  });

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
    expect(byId["avg-mx"]?.value).toBe("—");
    expect(byId["avg-my"]?.value).toBe("—");
    expect(byId["avg-mz"]?.value).toBe("—");
    expect(byId["energy-total"]?.value).toBe("15");
    expect(byId["max-torque"]?.value).toBe("6.000000e-3 T");
    expect(byId.step?.value).toBe("99");
    expect(byId.rate?.label).toBe("End-to-end rate");
    expect(byId.rate?.detail).toBe("Closed profiler span");

  });

  it("hides magnetic telemetry only for a ready, explicitly nonmagnetic scene", () => {
    const scene = { objects: [{ id: "conductor", name: "Conductor" }], revision: 1 } satisfies SceneResource;
    const magneticModelPresent = resolveFooterMagneticModelPresent({ data: scene, status: "ready" });
    expect(magneticModelPresent).toBe(false);
    const model = buildFooterTelemetryModel(currentStatus, objectMetrics, null, null, null, null, null, null, { magneticModelPresent });
    expect(model.metrics.some((metric) => metric.id.startsWith("avg-m") || metric.id.startsWith("energy-") || metric.id === "max-torque")).toBe(false);
    expect(model.metrics.some((metric) => metric.id === "time")).toBe(true);
  });

  it("keeps telemetry cards stable while a retained nonmagnetic scene refreshes", () => {
    const scene = { objects: [{ id: "conductor", name: "Conductor" }], revision: 1 } satisfies SceneResource;
    const cards = (["ready", "stale", "ready"] as const).map((resourceStatus) => {
      const magneticModelPresent = resolveFooterMagneticModelPresent({ data: scene, status: resourceStatus });
      return buildFooterTelemetryModel(currentStatus, null, null, null, null, null, null, null,
        { magneticModelPresent }).metrics.map(({ id }) => id);
    });
    expect(cards[1]).toEqual(cards[0]);
    expect(cards[2]).toEqual(cards[0]);
    expect(cards[0]).not.toContain("energy-total");
  });

  it("retains global magnetic telemetry when a nonmagnetic object is selected in a mixed scene", () => {
    const scene = { objects: [
      { id: "conductor", name: "Conductor" },
      { id: "film", name: "Film", magnetization_ref: "initial_m" },
    ], revision: 1 } satisfies SceneResource;
    expect(resolvePrimaryTelemetryObjectId(scene, "conductor")).toBeNull();
    const magneticModelPresent = resolveFooterMagneticModelPresent({ data: scene, status: "ready" });
    expect(magneticModelPresent).toBe(true);
    const model = buildFooterTelemetryModel(currentStatus, null, null, null, null, null, null, null, { magneticModelPresent });
    expect(model.metrics.some((metric) => metric.id === "avg-mx")).toBe(true);
    expect(model.metrics.some((metric) => metric.id === "energy-total")).toBe(true);
  });

  it("keeps unknown scene availability distinct from a nonmagnetic scene", () => {
    expect(resolveFooterMagneticModelPresent({ data: null, status: "loading" })).toBeNull();
    expect(resolveFooterMagneticModelPresent({ data: { revision: 1 }, status: "ready" })).toBeNull();
    expect(resolveFooterMagneticModelPresent({ data: { objects: [], revision: 1 }, status: "loading" })).toBeNull();
    const model = buildFooterTelemetryModel({ ...currentStatus!, solver: { state: "unknown", dt: null, max_torque_T: null } }, null, null, null, null, null, null, null, { magneticModelPresent: null });
    expect(model.metrics.find((metric) => metric.id === "max-torque")?.value).toBe("—");
    expect(model.metrics.find((metric) => metric.id === "dt")?.value).toBe("—");
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, 0])("distinguishes absent torque and timestep from genuine zero: %s", (value) => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: { ...status, solver: { ...status.solver, max_torque_T: value, dt: value } },
      error: null, refetch: () => {}, revision: 1, status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, null);
    expect(model.metrics.find((metric) => metric.id === "max-torque")?.value).toBe(value === 0 ? "0.000000e0 T" : "—");
    expect(model.metrics.find((metric) => metric.id === "dt")?.value).toBe(value === 0 ? "0.000000e+0" : "—");
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
    expect(model.onlineTitle).toBe("Session / Waiting");
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
        error_estimate: 2.5e-7,
        max_error: 1e-6,
        dt_suggested: 3e-12,
        rejected_attempts: 2,
        step: 123,
        time: 2.5,
      },
      requestScopeEpoch: "test-api:0",
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
    expect(byId["solver-error"]?.value).toBe("2.500000e-7");
    expect(byId["solver-error"]?.subdetail).toContain("2 rejected");
    expect(byId["solver-max-error"]?.value).toBe("1.000000e-6");
    expect(byId["solver-max-error"]?.subdetail).toBe("Within tolerance");
  });

  it("keeps small simulation times readable in seconds and marks absent values", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: {
        ...status,
        run: { ...status.run!, solver_time: 4e-9 },
      },
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const model = buildFooterTelemetryModel(telemetryStatus, null);
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId.time?.value).toBe("4.000000e-9");
    expect(byId.time?.unit).toBe("s");
    expect(byId.rate?.value).toBe("4.2");
    expect(byId.rate?.unit).toBe("steps/s");

    const emptyModel = buildFooterTelemetryModel({
      ...telemetryStatus,
      run: null,
      metrics: { ...telemetryStatus.metrics, steps_per_second: Number.NaN, total_steps: Number.NaN },
      solver: { ...telemetryStatus.solver, dt: Number.NaN, max_torque_T: Number.NaN },
    }, null);
    const emptyById = Object.fromEntries(emptyModel.metrics.map((metric) => [metric.id, metric]));
    expect(emptyById.time?.value).toBe("—");
    expect(emptyById.time?.unit).toBe("s");
    expect(emptyById.rate?.value).toBe("—");
    expect(emptyById.rate?.subdetail).toBe("— steps");
    expect(emptyById.step?.value).toBe("—");
    expect(emptyById.step?.subdetail).toBe("t=— s");
    expect(emptyById.dt?.value).toBe("—");
    expect(emptyById["max-torque"]?.value).toBe("—");
  });

  it("hydrates global magnetization from the HTTP scalar resource without a websocket event", () => {
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
      null,
      null,
      null,
      null,
      null,
      {
        revision: 22,
        row: { step: 99, time: 1.25e-9, mx: 0.25, my: -0.5, mz: 0.75 },
        requestScopeEpoch: "test-api:0",
        runId: "run-1",
        sessionId: "session-1",
      },
    );
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId["avg-mx"]?.value).toBe("0.250000");
    expect(byId["avg-my"]?.value).toBe("-0.500000");
    expect(byId["avg-mz"]?.value).toBe("0.750000");
    expect(byId["avg-mx"]?.subdetail).toBe("Scalar history resource");
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
          mx: 1, my: 0, mz: 0,
          pseudo_time_s: 9e-6,
          step: 9,
          time: 0,
        },
        requestScopeEpoch: "test-api:0",
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
    expect(byId["active-runtime"]?.value).toBe("0.200 s");
    expect(byId.dt?.label).toBe("Pseudo dt");
    expect(byId.dt?.detail).toBe("Minimizer pseudotime step");
    expect(byId.step?.subdetail).toBe("t=0.000000e+0 s");
  });

  it("shows frequency-response sweep progress instead of time-step progress", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const stageExecution: StageExecutionResource = {
      active_stage_index: 0,
      active_stage_kind: "flat_frequency_response",
      completed_stage_indexes: [],
      request_scope_epoch: status.session.request_scope_epoch,
      revision: 7,
      run_id: status.run!.run_id,
      runtime_state: "running",
      session_epoch: status.session.session_epoch,
      session_id: status.session.session_id,
      stage_statuses: ["running"],
      stages: [
        {
          converged: false,
          index: 0,
          kind: "flat_frequency_response",
          label: "Frequency response",
          progress_detail:
            "frequency point 1/4; f=2.750000 GHz; GMRES iteration=384; relative residual=8.500e-4",
          progress_label: "solving frequency point",
          progress_percent: 25,
          stage_id: "stage-3",
          status: "running",
        },
      ],
      total_stages: 1,
    };
    const responseProgress: FrequencyDomainSweepProgressResource = {
      complete: false,
      completed_frequency_points: 1,
      current_frequency_hz: 2.75e9,
      latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
      missing_reason: null,
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running"}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "running",
      status: "ready",
      total_frequency_points: 4,
      written_frequency_point_artifacts: 1,
    };

    const model = buildFooterTelemetryModel(
      telemetryStatus,
      objectMetrics,
      solverStatusFixture({
        algorithm: "fem_frequency_response_production_cpu",
        can_accept_commands: false,
        converged: false,
        dt_seconds: 0,
        integrator: null,
        is_busy: true,
        last_error: null,
        max_torque_T: 0,
        active_runtime_seconds: 12.5,
        pseudo_time_seconds: null,
        revision: 8,
        run_id: status.run?.run_id ?? null,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        stage_kind: "flat_frequency_response",
        step_index: 257,
        warnings: [],
      }),
      null,
      stageExecution,
      responseProgress,
      {
        points: [
          { frequency_hz: 2.0e9 },
          { frequency_hz: 3.0e9 },
          { frequency_hz: 4.0e9 },
          { frequency_hz: 5.0e9 },
        ],
        schema_version: "frequency_domain_response_sweep_resource.v1",
      },
    );

    expect(model.frequencyDomainProgress?.title).toBe("Frequency response");
    expect(model.frequencyDomainProgress?.percent).toBe(25);
    expect(model.frequencyDomainProgress?.percentLabel).toBe("25%");
    expect(model.frequencyDomainProgress?.pointLabel).toBe("point 1/4");
    expect(model.frequencyDomainProgress?.solutionLabel).toBe("solution 1/4");
    expect(model.frequencyDomainProgress?.frequencyLabel).toBe("2.750 GHz");
    expect(model.frequencyDomainProgress?.solverLabel).toBe("GMRES 384");
    expect(model.frequencyDomainProgress?.residualLabel).toBe("relres 8.500e-4");
    expect(model.frequencyDomainProgress?.rangeLabel).toBe("2.000-5.000 GHz");
    expect(model.frequencyDomainProgress?.detail).toContain("solution 1/4");
    expect(model.frequencyDomainProgress?.detail).toContain("GMRES 384");
    expect(model.frequencyDomainProgress?.detail).toContain("2.750 GHz");
    expect(model.frequencyDomainProgress?.detail).toContain("2.000-5.000 GHz");
  });

  it("shows periodic demag frequency-response progress as a distinct sweep mode", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const stageExecution: StageExecutionResource = {
      active_stage_index: 0,
      active_stage_kind: "flat_frequency_response",
      completed_stage_indexes: [],
      request_scope_epoch: status.session.request_scope_epoch,
      revision: 9,
      run_id: status.run!.run_id,
      runtime_state: "running",
      session_epoch: status.session.session_epoch,
      session_id: status.session.session_id,
      stage_statuses: ["running"],
      stages: [
        {
          converged: false,
          index: 0,
          kind: "flat_frequency_response",
          label: "Frequency response",
          progress_detail:
            "demag=periodic_airbox_k0; range=2.000000-5.000000 GHz; frequency point 2/7; completed=1; f=3.000000 GHz; GMRES iteration=64; current frequency solve=25%; relative residual=7.500e-3",
          progress_label: "solving frequency point",
          progress_percent: 14,
          stage_id: "stage-3",
          status: "running",
        },
      ],
      total_stages: 1,
    };

    const model = buildFooterTelemetryModel(
      telemetryStatus,
      objectMetrics,
      solverStatusFixture({
        algorithm: "fem_frequency_response_production_cpu",
        can_accept_commands: false,
        converged: false,
        dt_seconds: 0,
        integrator: null,
        is_busy: true,
        last_error: null,
        max_torque_T: 0,
        active_runtime_seconds: 18.5,
        pseudo_time_seconds: null,
        revision: 10,
        run_id: status.run?.run_id ?? null,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        stage_kind: "flat_frequency_response",
        step_index: 257,
        warnings: [],
      }),
      null,
      stageExecution,
      {
        complete: false,
        completed_frequency_points: 1,
        current_frequency_hz: 3.0e9,
        latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
        missing_reason: null,
        partial_artifacts_available: true,
        progress_json:
          '{"schema_version":"frequency_domain_sweep_progress.v1","state":"solving_frequency"}',
        schema_version: "frequency_domain_sweep_progress.v1",
        state: "running",
        status: "ready",
        total_frequency_points: 7,
        written_frequency_point_artifacts: 1,
      },
      null,
    );

    expect(model.frequencyDomainProgress?.title).toBe("Demag frequency sweep");
    expect(model.frequencyDomainProgress?.modeLabel).toBe("periodic airbox demag");
    expect(model.frequencyDomainProgress?.pointLabel).toBe("point 2/7");
    expect(model.frequencyDomainProgress?.solutionLabel).toBe("solution 2/7");
    expect(model.frequencyDomainProgress?.solveLabel).toBe("solve 25%");
    expect(model.frequencyDomainProgress?.rangeLabel).toBe("2.000-5.000 GHz");
    expect(model.frequencyDomainProgress?.detail).toContain("periodic airbox demag");
    expect(model.frequencyDomainProgress?.detail).toContain("solution 2/7");
    expect(model.frequencyDomainProgress?.detail).toContain("solve 25%");
  });

  it("shows an indeterminate frequency-response progress before the first point reports", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const stageExecution: StageExecutionResource = {
      active_stage_index: 0,
      active_stage_kind: "flat_frequency_response",
      completed_stage_indexes: [],
      request_scope_epoch: status.session.request_scope_epoch,
      revision: 7,
      run_id: status.run!.run_id,
      runtime_state: "running",
      session_epoch: status.session.session_epoch,
      session_id: status.session.session_id,
      stage_statuses: ["running"],
      stages: [
        {
          converged: false,
          index: 0,
          kind: "flat_frequency_response",
          label: "Frequency response",
          progress_detail: null,
          progress_label: null,
          progress_percent: null,
          stage_id: "stage-3",
          status: "running",
        },
      ],
      total_stages: 1,
    };

    const model = buildFooterTelemetryModel(
      telemetryStatus,
      objectMetrics,
      solverStatusFixture({
        algorithm: "fem_frequency_response_production_cpu",
        can_accept_commands: false,
        converged: false,
        dt_seconds: 0,
        integrator: null,
        is_busy: true,
        last_error: null,
        max_torque_T: 0,
        active_runtime_seconds: 12.5,
        pseudo_time_seconds: null,
        revision: 8,
        run_id: status.run?.run_id ?? null,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        stage_kind: "flat_frequency_response",
        step_index: 257,
        warnings: [],
      }),
      null,
      stageExecution,
      null,
      {
        frequencies_hz: [2.0e9, 3.0e9, 4.0e9, 5.0e9],
        schema_version: "frequency_domain_response_sweep_resource.v1",
      },
    );

    expect(model.frequencyDomainProgress?.title).toBe("Frequency response");
    expect(model.frequencyDomainProgress?.percent).toBeNull();
    expect(model.frequencyDomainProgress?.percentLabel).toBe("running");
    expect(model.frequencyDomainProgress?.pointLabel).toBe("waiting for first point");
    expect(model.frequencyDomainProgress?.frequencyLabel).toBe("pending");
    expect(model.frequencyDomainProgress?.rangeLabel).toBe("2.000-5.000 GHz");
    expect(model.frequencyDomainProgress?.detail).toBe(
      "waiting for first frequency point · range 2.000-5.000 GHz",
    );
  });

  it("uses durable progress range and demag mode when stage detail and sweep are absent", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const stageExecution: StageExecutionResource = {
      active_stage_index: 0,
      active_stage_kind: "flat_frequency_response",
      completed_stage_indexes: [],
      request_scope_epoch: status.session.request_scope_epoch,
      revision: 12,
      run_id: status.run!.run_id,
      runtime_state: "running",
      session_epoch: status.session.session_epoch,
      session_id: status.session.session_id,
      stage_statuses: ["running"],
      stages: [
        {
          converged: false,
          index: 0,
          kind: "flat_frequency_response",
          label: "Frequency response",
          progress_detail: null,
          progress_label: null,
          progress_percent: 0,
          stage_id: "stage-3",
          status: "running",
        },
      ],
      total_stages: 1,
    };

    const model = buildFooterTelemetryModel(
      telemetryStatus,
      objectMetrics,
      solverStatusFixture({
        algorithm: "fem_frequency_response_production_cpu",
        can_accept_commands: false,
        converged: false,
        dt_seconds: 0,
        integrator: null,
        is_busy: true,
        last_error: null,
        max_torque_T: 0,
        active_runtime_seconds: 8.5,
        pseudo_time_seconds: null,
        revision: 13,
        run_id: status.run?.run_id ?? null,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        stage_kind: "flat_frequency_response",
        step_index: 257,
        warnings: [],
      }),
      null,
      stageExecution,
      {
        complete: false,
        completed_frequency_points: 0,
        current_frequency_hz: 2.0e9,
        demag_mode: "periodic_airbox_k0",
        frequency_max_hz: 5.0e9,
        frequency_min_hz: 2.0e9,
        latest_artifact_manifest_path: null,
        missing_reason: null,
        partial_artifacts_available: false,
        progress_json:
          '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running","completed_frequency_points":0,"total_frequency_points":7,"native_frequency_index":0,"native_iteration_count":128,"native_max_iterations_for_frequency":256,"native_current_frequency_solve_fraction":0.5,"frequency_min_hz":2000000000.0,"frequency_max_hz":5000000000.0,"demag_mode":"periodic_airbox_k0"}',
        schema_version: "frequency_domain_sweep_progress.v1",
        state: "running",
        status: "running",
        total_frequency_points: 7,
        written_frequency_point_artifacts: 0,
      },
      null,
    );

    expect(model.frequencyDomainProgress?.title).toBe("Demag frequency sweep");
    expect(model.frequencyDomainProgress?.modeLabel).toBe("periodic airbox demag");
    expect(model.frequencyDomainProgress?.percent).toBe(7);
    expect(model.frequencyDomainProgress?.percentLabel).toBe("7%");
    expect(model.frequencyDomainProgress?.pointLabel).toBe("point 1/7");
    expect(model.frequencyDomainProgress?.solutionLabel).toBe("solution 1/7");
    expect(model.frequencyDomainProgress?.frequencyLabel).toBe("2.000 GHz");
    expect(model.frequencyDomainProgress?.solveLabel).toBe("solve 50%");
    expect(model.frequencyDomainProgress?.solverLabel).toBe("GMRES 128/256");
    expect(model.frequencyDomainProgress?.rangeLabel).toBe("2.000-5.000 GHz");
    expect(model.frequencyDomainProgress?.detail).toBe(
      "periodic airbox demag · solution 1/7 · 2.000 GHz · solve 50% · GMRES 128/256 · range 2.000-5.000 GHz",
    );
  });

  it("shows eigenmode solver progress from stage execution", () => {
    const telemetryStatus = selectFooterTelemetryStatus({
      data: status,
      error: null,
      refetch: () => {},
      revision: 1,
      status: "ready",
    });
    const stageExecution: StageExecutionResource = {
      active_stage_index: 0,
      active_stage_kind: "flat_eigenmodes",
      completed_stage_indexes: [],
      request_scope_epoch: status.session.request_scope_epoch,
      revision: 11,
      run_id: status.run!.run_id,
      runtime_state: "running",
      session_epoch: status.session.session_epoch,
      session_id: status.session.session_id,
      stage_statuses: ["running"],
      stages: [
        {
          converged: false,
          index: 0,
          kind: "flat_eigenmodes",
          label: "Eigenmodes",
          progress_detail:
            "solving sparse LOBPCG; solver=cpu_sparse_lobpcg; active_nodes=1931; effective_dof=3862; requested_modes=20; computed_modes=4; iteration=37/5000; residual=1.200e-5",
          progress_label: "solving sparse LOBPCG",
          progress_percent: 48,
          stage_id: "stage-2",
          status: "running",
        },
      ],
      total_stages: 1,
    };

    const model = buildFooterTelemetryModel(
      telemetryStatus,
      objectMetrics,
      solverStatusFixture({
        algorithm: "fem_eigen_production_cpu",
        can_accept_commands: false,
        converged: false,
        dt_seconds: 0,
        integrator: null,
        is_busy: true,
        last_error: null,
        max_torque_T: 0,
        active_runtime_seconds: 22.5,
        pseudo_time_seconds: null,
        revision: 12,
        run_id: status.run?.run_id ?? null,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        sim_time_seconds: 0,
        stage_kind: "flat_eigenmodes",
        step_index: 37,
        warnings: [],
      }),
      null,
      stageExecution,
      {
        complete: false,
        completed_frequency_points: 1,
        current_frequency_hz: 2.75e9,
        latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
        missing_reason: null,
        partial_artifacts_available: true,
        progress_json:
          '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running"}',
        schema_version: "frequency_domain_sweep_progress.v1",
        state: "running",
        status: "ready",
        total_frequency_points: 4,
        written_frequency_point_artifacts: 1,
      },
      {
        points: [{ frequency_hz: 2.0e9 }, { frequency_hz: 5.0e9 }],
        schema_version: "frequency_domain_response_sweep_resource.v1",
      },
    );

    expect(model.frequencyDomainProgress?.title).toBe("Eigenmodes");
    expect(model.frequencyDomainProgress?.percent).toBe(48);
    expect(model.frequencyDomainProgress?.percentLabel).toBe("48%");
    expect(model.frequencyDomainProgress?.detail).toContain("solving sparse LOBPCG");
    expect(model.frequencyDomainProgress?.detail).toContain("effective_dof=3862");
    expect(model.frequencyDomainProgress?.detail).toContain("iteration=37/5000");
    expect(model.frequencyDomainProgress?.detail).toContain("residual=1.200e-5");
    expect(model.frequencyDomainProgress?.detail).not.toContain("range 2.000-5.000 GHz");
  });

  it("does not use unscoped scalar history as current-run telemetry", () => {
    const live = {
      revision: 26,
      sessionId: currentStatus!.sessionId,
      requestScopeEpoch: "test-api:0",
      runId: currentStatus!.run!.run_id,
      step: 9,
      time: 0,
      row: {
        step: 9,
        time: 0,
        mx: 1,
        my: 0,
        mz: 0,
        pseudo_time_s: 9e-6,
        active_runtime_s: 3,
        solver_dt: 1e-8,
        e_ex: 7,
        e_total: 8,
      },
    };
    const unscopedHistory = {
      revision: 26,
      total_rows: 1,
      returned_rows: 1,
      columns: ["step", "time", "mx", "my", "mz", "e_total"],
      rows: [[9, 0, 1, 0, 0, 8]],
      observation_frames: [],
    };
    const before = buildFooterTelemetryModel(currentStatus, null, null, live);
    const after = buildFooterTelemetryModel(
      currentStatus,
      null,
      null,
      live,
      null,
      null,
      null,
      unscopedHistory,
    );
    expect(after.metrics).toEqual(before.metrics);
    expect(after.metrics.find(({ id }) => id === "time")?.label).toBe("Pseudo time");

    const completedStatus = selectFooterTelemetryStatus({
      data: {
        ...status,
        energies: { ...status.energies, total: -3.668191276379833e-16 },
        run: { ...status.run!, solver_steps: 10, solver_time: 0 },
        solver: { ...status.solver, state: "completed" },
      },
      error: null,
      refetch: () => {},
      revision: 2,
      status: "ready",
    });
    const olderRealtime = {
      ...live,
      step: 0,
      row: { step: 0, time: 0, mx: 1, my: 0, mz: 0, e_total: 8 },
    };
    const newerUnscopedHistory = {
      ...unscopedHistory,
      revision: 27,
      rows: [[11, 0, 0, 1, 0, 12]],
    };
    const terminalBaseline = buildFooterTelemetryModel(completedStatus, null);
    // A newer table tail has no run identity and cannot supersede this run's status.
    const updated = buildFooterTelemetryModel(
      completedStatus,
      null,
      null,
      olderRealtime,
      null,
      null,
      null,
      newerUnscopedHistory,
    );
    expect(updated.metrics).toEqual(terminalBaseline.metrics);
    expect(updated.metrics.find(({ id }) => id === "step")?.value).toBe("10");
    expect(updated.metrics.find(({ id }) => id === "time")?.label).toBe("Sim time");
    expect(updated.metrics.some(({ id }) => id === "active-runtime")).toBe(false);
    expect(
      updated.metrics.find(({ id }) => id === "energy-total")?.subdetail,
    ).toBe("Session summary");
  });

  it.each(["previous-api:0", null])(
    "ignores higher-revision realtime samples from scope %s after API restart",
    (requestScopeEpoch) => {
      const completedStatus = {
        ...currentStatus!,
        solver: { ...currentStatus!.solver, state: "completed" },
      };
      const model = buildFooterTelemetryModel(
        completedStatus,
        null,
        null,
        {
          requestScopeEpoch,
          revision: 999,
          row: { step: 12, time: 3601, mx: -1, my: 0, mz: 0 },
          runId: completedStatus.run!.run_id,
          sessionId: completedStatus.sessionId,
          step: 12,
          time: 3601,
        },
        null,
        null,
        null,
        {
          columns: ["step", "time", "mx", "my", "mz", "e_total"],
          current_observation: {
            request_scope_epoch: completedStatus.requestScopeEpoch,
            run_id: completedStatus.run!.run_id,
            scalar_revision: 26,
            session_id: completedStatus.sessionId,
            source_step: 12,
          },
          observation_frames: [],
          returned_rows: 1,
          revision: 26,
          rows: [[12, 3601, 0.5, 0, 0, 1.5]],
          total_rows: 1,
        },
      );
      expect(model.metrics.find(({ id }) => id === "avg-mx")?.value).toBe("0.5");
      expect(model.metrics.find(({ id }) => id === "step")?.value).toBe("12");
    },
  );

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
      requestScopeEpoch: "test-api:0",
      runId: "run-1",
      sessionId: "session-1",
      step: 9,
      time: 0,
    });
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(byId.time?.label).toBe("Sim time");
    expect(byId["sim-time"]).toBeUndefined();
    expect(byId.dt?.label).toBe("dt");
    expect(byId["avg-mx"]?.value).toBe("—");
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
        { id: "arch_waveguide", name: "Arch waveguide", magnetization_ref: "initial_m" },
        { id: "free_layer", name: "Free layer", magnetization_ref: "initial_m" },
      ],
      revision: 2,
    } satisfies SceneResource;

    expect(resolvePrimaryTelemetryObjectId(scene, "free_layer")).toBe("free_layer");
    expect(resolvePrimaryTelemetryObjectId(scene)).toBe("arch_waveguide");
    expect(resolvePrimaryTelemetryObjectId(scene, "missing")).toBe("arch_waveguide");
    expect(resolvePrimaryTelemetryObjectId({ objects: [], revision: 3 })).toBeNull();
  });
});
