import { describe, expect, it } from "vitest";

import type { TopologicalChargeResource } from "@/kernel/api/apiTypes";

import { resolveTopologicalChargePanelModel } from "./topologicalChargeModel";

const readyResource: TopologicalChargeResource = {
  schema_version: "topological_charge.v2",
  resource_revision: "91",
  object_id: "permalloy_ring",
  status: "ready",
  trust: "diagnostic_resolution",
  charge: -0.9823412,
  nearest_integer: null,
  integer_error: null,
  request: {
    requested_plane: "xy",
    requested_support: "layer_profile",
    requested_profile_samples: { count: 2 },
    snapshot_id: null,
    stage_id: null,
  },
  resolved_support: {
    plane: "xy",
    support: "layer_profile",
    profile_sample_count: 2,
    source_kind: "exact_plane_cut",
    coordinate_m: null,
  },
  support_frame: { u_axis: [1, 0, 0], v_axis: [0, 1, 0], normal_axis: [0, 0, 1] },
  profile: [
    { index: 0, coordinate_m: -4.0e-8, integration_weight_m: 4.0e-8, status: "ready", trust: "diagnostic_resolution", charge: -0.9823412, valid_triangle_count: 1152, total_triangle_count: 1152 },
    { index: 1, coordinate_m: 4.0e-8, integration_weight_m: 4.0e-8, status: "ready", trust: "diagnostic_resolution", charge: -0.9818918, valid_triangle_count: 1152, total_triangle_count: 1152 },
  ],
  quality: {
    total_vertex_count: 1250, valid_vertex_count: 1250, total_triangle_count: 2304,
    valid_triangle_count: 2304, invalid_triangle_count: 0, exceptional_triangle_count: 0,
    max_edge_angle_rad: null, min_abs_solid_angle_denominator: null,
    connected_component_count: 1, boundary_edge_count: 96, boundary_loop_count: 1,
    euler_characteristic: 1, boundary_max_deviation_rad: null,
  },
  provenance: {
    source_kind: "current_live", field_id: "m", field_revision: "42",
    field_storage_domain: "fem_nodal", field_node_mapping_id: "magnetic_node_indices.v1",
    scene_revision: "91", mesh_revision: "17", mesh_generation_id: "mesh-gen-9",
    domain_generation_id: "domain-7", snapshot_id: null, stage_id: null,
    discretization: "fem", fe_order: 1, cache_key_digest: "digest",
  },
  method: { id: "berg_luescher_oriented_triangles_v2", version: "2", quantity_id: "m" },
  computed_at_unix_ms: 1_772_000_000_000,
  warnings: [{ code: "under_resolved", severity: "warning", message: "Some neighboring magnetization directions indicate an under-resolved texture." }],
};

describe("topologicalChargeModel", () => {
  it("formats a versioned result without inventing polarity", () => {
    const model = resolveTopologicalChargePanelModel("ready", readyResource);

    expect(model.banner).toEqual({ kind: "warning", message: readyResource.warnings?.[0]?.message });
    expect(model.method.sampleQuality).toBe("2304/2304 valid triangles (100.00%)");
    expect(model.rows).toContainEqual({ label: "Schema", value: "topological_charge.v2" });
    expect(model.rows).toContainEqual({ label: "Trust", value: "diagnostic_resolution" });
    expect(model.rows).toContainEqual({ label: "Plane", value: "xy" });
    expect(model.rows).toContainEqual({ label: "Support", value: "layer_profile" });
    expect(model.rows).not.toContainEqual(expect.objectContaining({ label: "Polarity" }));
  });

  it("renders missing resources without pretending a charge is available", () => {
    const model = resolveTopologicalChargePanelModel("loading", null);
    expect(model.banner).toBeUndefined();
    expect(model.rows).toContainEqual({ label: "Q", value: "unavailable" });
    expect(model.rows).toContainEqual({ label: "Trust", value: "unavailable" });
  });

  it("uses typed scientific status when a computation is unavailable", () => {
    const model = resolveTopologicalChargePanelModel("ready", {
      ...readyResource, charge: null, integer_error: null, nearest_integer: null,
      profile: [], status: "invalid_magnetization", warnings: [],
    });
    expect(model.banner).toEqual({ kind: "warning", message: "Topological charge status: invalid magnetization." });
  });
});
