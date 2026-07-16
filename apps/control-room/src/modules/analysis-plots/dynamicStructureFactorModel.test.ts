import { describe, expect, it } from "vitest";

import { dynamicStructureFactorCells, dynamicStructureFactorFrequencyCut, dynamicStructureFactorWavevectorCut } from "./dynamicStructureFactorModel";

describe("dynamicStructureFactorModel", () => {
  it("preserves physical axes and bounds the rendered heatmap", () => {
    const resource = {
      schema_version: "dynamic_structure_factor.1d.v1",
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: true,
      original_frequency_count: 100,
      original_wavevector_count: 100,
      wavevector_unit: "rad/m",
      frequency_unit: "Hz",
      x_m: Array.from({ length: 100 }, (_, index) => index * 1e-9),
      time_s: Array.from({ length: 198 }, (_, index) => index * 1e-12),
      k_rad_per_m: Array.from({ length: 100 }, (_, index) => index),
      frequency_hz: Array.from({ length: 100 }, (_, index) => index * 1e9),
      power: Array.from({ length: 10_000 }, (_, index) => index),
      spectrum_real: Array.from({ length: 10_000 }, () => 0),
      spectrum_imag: Array.from({ length: 10_000 }, () => 0),
      source_power: Array.from({ length: 10_000 }, () => 0),
      source_spectrum_real: Array.from({ length: 10_000 }, () => 0),
      source_spectrum_imag: Array.from({ length: 10_000 }, () => 0),
      source_observable: "H_drive_y",
      source_unit: "A/m",
      component: "my",
      propagation_axis: "x",
      phase_convention: "exp[-i(k*x-2*pi*f*t)]",
      normalization: "one_sided_abs_fft2_squared_over_Nx_Nt_Ux_Ut",
      spatial_window: Array.from({ length: 100 }, () => 1),
      temporal_window: Array.from({ length: 198 }, () => 1),
      spatial_window_power_sum: 100,
      temporal_window_power_sum: 198,
      mesh_probe_signature: "fixture",
      invalid_probe_mask: Array.from({ length: 100 }, () => false),
      excluded_absorber_ranges_m: [],
      frequency_count: 100,
      wavevector_count: 100,
    };
    const cells = dynamicStructureFactorCells(resource);
    expect(cells.length).toBeLessThanOrEqual(4096);
    expect(cells.at(-1)?.normalizedPower).toBeLessThanOrEqual(1);
    expect(dynamicStructureFactorFrequencyCut(resource, 2)[0].points).toHaveLength(100);
    expect(dynamicStructureFactorWavevectorCut(resource, 3)[0].points).toHaveLength(100);
    expect(dynamicStructureFactorCells(resource, "source")).toHaveLength(cells.length);
    expect(dynamicStructureFactorFrequencyCut(resource, 2, "source")[0].unit).toBe("(A/m)²");
  });
});
