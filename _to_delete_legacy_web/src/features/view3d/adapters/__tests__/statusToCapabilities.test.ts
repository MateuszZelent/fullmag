import { describe, expect, it } from "vitest";

import type { LiveStatus } from "../../../../api/types";
import { statusToViewport3DCapabilities } from "../statusToCapabilities";

const baseStatus: LiveStatus = {
  api_contract_version: "v1",
  runtime_bundle_version: "v1",
  session: {
    session_id: "s",
    name: "session",
    created_at: "2026-04-23T00:00:00Z",
    workspace_root: "/tmp",
  },
  run: null,
  solver: {
    state: "idle",
    algorithm: null,
    dt: null,
    max_torque: null,
    converged: null,
  },
  display: {
    active_quantity_id: "m",
    view_mode: "3d",
    field_component: "magnitude",
    colormap: "viridis",
    auto_contrast: true,
    contrast_min: null,
    contrast_max: null,
    vector_glyphs: false,
    vector_density: 8,
    slice_mode: "plane",
    slice_layer: 0,
    max_points: 1000,
    x_chosen_size: 128,
    y_chosen_size: 128,
  },
  domain: {
    generation_id: 1,
    discretization: "fem",
    cell_count: 1024,
  },
  resources: {
    topology_revision: 1,
    field_catalog_revision: 1,
    field_revision: 1,
    slice_revision: 1,
    artifact_revision: 1,
    command_completion_revision: 1,
    fields_revision: 1,
    scalars_revision: 1,
    domain_generation_id: 1,
    artifacts_revision: 1,
    engine_log_revision: 1,
    display_revision: 1,
    workspace_revision: 1,
    mesh_revision: 1,
    mesh_build_revision: 1,
    commands_revision: 1,
    stages_revision: 1,
    scene_revision: null,
  },
  capabilities: {
    structured_grid: false,
    explicit_topology: true,
    binary_fields: true,
    cell_fields: false,
    node_fields: true,
    scalar_history: true,
    eigen_modes: false,
    gpu_telemetry: false,
    preview_2d: true,
    preview_3d: true,
    algorithms_available: ["heun", "rk45"],
  },
  energies: {
    total: null,
    exchange: null,
    demag: null,
    zeeman: null,
    anisotropy: null,
    dmi: null,
  },
  metrics: {
    uptime_seconds: 0,
    total_steps: 0,
    steps_per_second: null,
  },
};

describe("statusToViewport3DCapabilities", () => {
  it("maps capabilities from status.capabilities only", () => {
    const mapped = statusToViewport3DCapabilities(baseStatus);
    expect(mapped.can_render_3d).toBe(true);
    expect(mapped.can_show_topology).toBe(true);
    expect(mapped.can_show_vectors).toBe(true);
    expect(mapped.can_show_scalar_history).toBe(true);
    expect(mapped.algorithms_available).toEqual(["heun", "rk45"]);
  });

  it("does not synthesize capabilities from domain discretization", () => {
    const status: LiveStatus = {
      ...baseStatus,
      domain: {
        generation_id: 1,
        discretization: "fem",
        cell_count: 2048,
      },
      capabilities: {
        ...baseStatus.capabilities,
        preview_3d: false,
        explicit_topology: false,
        binary_fields: false,
        node_fields: false,
        cell_fields: false,
        scalar_history: false,
      },
    };
    const mapped = statusToViewport3DCapabilities(status);
    expect(mapped.can_render_3d).toBe(false);
    expect(mapped.can_show_topology).toBe(false);
    expect(mapped.can_show_vectors).toBe(false);
    expect(mapped.can_show_scalar_history).toBe(false);
  });
});
