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
      power: Array.from({ length: 200_000 }, (_, index) => index),
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

  it("preserves exact chart-series identity, units, points, source, and status", () => {
    const resource = {
      frequency_count: 2,
      frequency_hz: [0, 5e9],
      frequency_unit: "Hz",
      k_rad_per_m: [10, 20],
      power: [1, 2, 3, 4],
      source_observable: "H_drive_y",
      source_power: [10, 20, 30, 40],
      source_unit: "A/m",
      wavevector_count: 2,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorFrequencyCut(resource, 1).map((entry) => ({
      dataRevision: entry.dataRevision ?? null,
      id: entry.id,
      points: entry.points,
      source: entry.source,
      status: entry.status,
      unit: entry.unit,
      xUnit: entry.xUnit,
    }))).toEqual([{
      dataRevision: null,
      id: "finite-k-frequency-cut-response",
      points: [{ rowIndex: 0, x: 0, y: 2 }, { rowIndex: 1, x: 5e9, y: 4 }],
      source: { kind: "analysis.spin_wave", resourceKey: "/v2/sessions/current/analysis/spin-wave/dynamic-structure-factor.v1", tableId: "dynamic-structure-factor" },
      status: "ready",
      unit: "1",
      xUnit: "Hz",
    }]);
  });
});
