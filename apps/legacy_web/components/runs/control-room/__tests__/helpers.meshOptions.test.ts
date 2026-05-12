import { describe, expect, it } from "vitest";

import { DEFAULT_MESH_OPTIONS } from "@/lib/mesh/options";
import type { ScriptBuilderMeshState } from "@/lib/session/types";

import { meshOptionsFromBuilder, meshOptionsToBuilder } from "../helpers";

function createBuilderMeshState(): ScriptBuilderMeshState {
  return {
    algorithm_2d: 6,
    algorithm_3d: 1,
    size_mode: "custom",
    hmax: "",
    hmin: "",
    maximum_element_size: "2e-08",
    minimum_element_size: "5e-09",
    calibrate_for: "general_physics",
    size_preset: "normal",
    size_factor: 1,
    size_from_curvature: 0,
    curvature_factor: "",
    growth_rate: "",
    maximum_element_growth_rate: "1.4",
    narrow_regions: 0,
    narrow_region_resolution: "",
    resolved_size_from_curvature: null,
    resolved_narrow_regions: null,
    resolved_growth_rate: "",
    smoothing_steps: 1,
    optimize: "",
    optimize_iterations: 1,
    compute_quality: true,
    per_element_quality: true,
    interface_hmax: "",
    interface_thickness: "",
    transition_distance: "",
    transition_growth: "",
    edge_hmax: "5e-09",
    edge_thickness: "1e-08",
    corner_hmax: "3e-09",
    corner_extent: "8e-09",
    adaptive_enabled: false,
    adaptive_policy: "auto",
    adaptive_indicator: "geometric_only",
    adaptive_target_quantity: "auto",
    adaptive_convergence_metric: "energy_delta",
    adaptive_theta: 0.3,
    adaptive_h_min: "",
    adaptive_h_max: "",
    adaptive_max_passes: 2,
    adaptive_error_tolerance: "1e-3",
  };
}

describe("meshOptions perimeter refinement mapping", () => {
  it("maps perimeter refinement from builder to mesh options", () => {
    const options = meshOptionsFromBuilder(createBuilderMeshState());
    expect(options.edgeHMax).toBe("5e-09");
    expect(options.edgeThickness).toBe("1e-08");
    expect(options.cornerHMax).toBe("3e-09");
    expect(options.cornerExtent).toBe("8e-09");
  });

  it("maps perimeter refinement from mesh options back to builder state", () => {
    const builder = meshOptionsToBuilder({
      ...DEFAULT_MESH_OPTIONS,
      maximumElementSize: "2e-08",
      minimumElementSize: "5e-09",
      edgeHMax: "5e-09",
      edgeThickness: "1e-08",
      cornerHMax: "3e-09",
      cornerExtent: "8e-09",
    });
    expect(builder.edge_hmax).toBe("5e-09");
    expect(builder.edge_thickness).toBe("1e-08");
    expect(builder.corner_hmax).toBe("3e-09");
    expect(builder.corner_extent).toBe("8e-09");
  });
});
