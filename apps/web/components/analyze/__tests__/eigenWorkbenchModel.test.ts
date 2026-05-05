import { describe, expect, it } from "vitest";

import type {
  EigenBranchesArtifact,
  EigenSelection,
  EigenSpectrumArtifactV2,
} from "../eigenTypes";
import {
  buildEigenDispersionTraces,
  buildEigenPathTickLabels,
  buildEigenSpectrumTrace,
  defaultEigenSelection,
  eigenSelectionFromDispersionCustomData,
  eigenSelectionFromSpectrumCustomData,
} from "../eigenWorkbenchModel";

const colors = {
  selected: "#selected",
  trace: "#trace",
  trace2: "#trace2",
};

const spectrum: EigenSpectrumArtifactV2 = {
  schema_version: "eigen_spectrum.v2",
  solver_model: "fem_dense",
  sample_count: 2,
  samples: [
    {
      sample_index: 0,
      label: "G",
      k_vector: [0, 0, 0],
      path_s: 0,
      segment_index: 0,
      t_in_segment: 0,
      modes: [
        {
          raw_mode_index: 0,
          branch_id: 4,
          frequency_real_hz: 1.2e9,
          frequency_imag_hz: 0,
          angular_frequency_rad_per_s: 7.54e9,
          eigenvalue_real: 1,
          eigenvalue_imag: 0,
          norm: 1,
          max_amplitude: 1,
          dominant_polarization: "x",
          k_vector: [0, 0, 0],
        },
      ],
    },
    {
      sample_index: 3,
      label: "X",
      k_vector: [2.5e8, 0, 0],
      path_s: 2.5e8,
      segment_index: 0,
      t_in_segment: 1,
      modes: [
        {
          raw_mode_index: 7,
          branch_id: 4,
          frequency_real_hz: 1.9e9,
          frequency_imag_hz: 0,
          angular_frequency_rad_per_s: 11.94e9,
          eigenvalue_real: 2,
          eigenvalue_imag: 0,
          norm: 1,
          max_amplitude: 1,
          dominant_polarization: "y",
          k_vector: [2.5e8, 0, 0],
        },
      ],
    },
  ],
};

const branches: EigenBranchesArtifact = {
  schema_version: "eigen_branches.v2",
  solver_model: "fem_dense",
  branches: [
    {
      branch_id: 4,
      label: "acoustic",
      points: [
        {
          sample_index: 0,
          raw_mode_index: 0,
          frequency_real_hz: 1.2e9,
          frequency_imag_hz: 0,
          tracking_confidence: 1,
        },
        {
          sample_index: 3,
          raw_mode_index: 7,
          frequency_real_hz: 1.9e9,
          frequency_imag_hz: 0,
          tracking_confidence: 0.93,
          overlap_prev: 0.93,
        },
      ],
    },
  ],
};

describe("eigen workbench model", () => {
  it("defaults selection to the first tracked branch point", () => {
    expect(defaultEigenSelection(spectrum, branches)).toEqual({
      branchId: 4,
      sampleIndex: 0,
      rawModeIndex: 0,
    });
  });

  it("builds dispersion traces on path_s with high-symmetry tick labels", () => {
    const selection: EigenSelection = { branchId: 4, sampleIndex: 3, rawModeIndex: 7 };
    const traces = buildEigenDispersionTraces(spectrum, branches, selection, colors);

    expect(buildEigenPathTickLabels(spectrum)).toEqual([
      { value: 0, label: "G" },
      { value: 2.5e8, label: "X" },
    ]);
    expect(traces).toHaveLength(1);
    expect(traces[0].x).toEqual([0, 2.5e8]);
    expect(traces[0].customdata).toEqual([
      [4, 0, 0],
      [4, 3, 7],
    ]);
    expect(traces[0].line.width).toBe(3);
    expect(traces[0].marker.size).toEqual([6, 10]);
  });

  it("maps Plotly customdata back to the selection payload", () => {
    expect(eigenSelectionFromDispersionCustomData([4, 3, 7])).toEqual({
      branchId: 4,
      sampleIndex: 3,
      rawModeIndex: 7,
    });

    expect(
      eigenSelectionFromSpectrumCustomData(7, spectrum, {
        branchId: 4,
        sampleIndex: 3,
        rawModeIndex: 0,
      }),
    ).toEqual({
      branchId: 4,
      sampleIndex: 3,
      rawModeIndex: 7,
    });

    expect(
      buildEigenSpectrumTrace(
        spectrum,
        { branchId: 4, sampleIndex: 3, rawModeIndex: 7 },
        colors,
      )[0].customdata,
    ).toEqual([7]);
  });
});
