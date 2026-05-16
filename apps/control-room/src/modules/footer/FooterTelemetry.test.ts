import { describe, expect, it } from "vitest";

import type {
  LiveStatusResource,
  ObjectMetricsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";

import {
  buildFooterTelemetryModel,
  resolvePrimaryTelemetryObjectId,
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
    max_torque: 0.006,
    state: "running",
  },
};

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
    const model = buildFooterTelemetryModel(status, objectMetrics);
    const byId = Object.fromEntries(model.metrics.map((metric) => [metric.id, metric]));

    expect(model.statusTitle).toBe("System Status: Running");
    expect(byId["avg-mx"]?.value).toBe("0.250");
    expect(byId["avg-my"]?.value).toBe("-0.500");
    expect(byId["avg-mz"]?.value).toBe("0.750");
    expect(byId["energy-total"]?.value).toBe("15");
    expect(byId.step?.value).toBe("99");
  });

  it("uses the first scene object as the telemetry object source", () => {
    const scene = {
      objects: [
        { id: "arch_waveguide", name: "Arch waveguide" },
        { id: "free_layer", name: "Free layer" },
      ],
      revision: 2,
    } satisfies SceneResource;

    expect(resolvePrimaryTelemetryObjectId(scene)).toBe("arch_waveguide");
    expect(resolvePrimaryTelemetryObjectId({ objects: [], revision: 3 })).toBeNull();
  });
});
