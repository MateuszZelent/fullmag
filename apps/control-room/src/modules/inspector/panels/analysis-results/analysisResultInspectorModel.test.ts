import { describe, expect, it } from "vitest";

import { buildAnalysisResultInspectorModel } from "./analysisResultInspectorModel";

const axis = {
  axis_id: "bias-field",
  cardinality: 15,
  inline_values: null,
  label: "Bias field",
  ordering: "source_order",
  preferred_display_units: ["mT"],
  projections: [],
  role: "outer_sweep",
  semantic_id: "bias_field_a_per_m",
  symbol: "μ₀Hₓ",
  unit_si: "A/m",
  value_kind: "vector3",
  values_resource_key: "/axes/bias-field/values",
};

const status = {
  completeness: "ready",
  execution: "published",
  qualification: "validated",
  resource: "ready",
};

function manifest(productKind: "time_domain_spectrum" | "dynamic_structure_factor", provenance: Record<string, string>) {
  return {
    axes: [axis],
    dataset_id: "dataset:time-domain",
    dataset_revision: "sha256:dataset-current",
    product_kind: productKind,
    provenance,
    source_artifacts: [{
      artifact: "analysis/time-series.zarr",
      relation: "adapter_source",
      revision: "sha256:source-current",
    }],
    status,
  };
}

describe("analysis result inspector model", () => {
  it("renders every required time-domain metadata value from the published manifest", () => {
    const model = buildAnalysisResultInspectorModel({
      item: null,
      manifest: manifest("time_domain_spectrum", {
        detrend: "mean",
        normalization: "one-sided power",
        nyquist_hz: "5e9 Hz",
        sampling_clock: "N=128; dt=1e-12 s",
        source_drive: "sinc H_y",
        uniformity_proof: "exact_physical_time_series",
        window: "hann",
      }),
    });

    expect(model.metadata).toEqual([
      { label: "Sampling clock", value: "N=128; dt=1e-12 s" },
      { label: "Uniformity proof", value: "exact_physical_time_series" },
      { label: "Window", value: "hann" },
      { label: "Detrend", value: "mean" },
      { label: "Normalization", mono: true, value: "one-sided power" },
      { label: "Nyquist", value: "5e9 Hz" },
      { label: "Source drive", value: "sinc H_y" },
      { label: "Completeness", value: "ready" },
    ]);
  });

  it("renders DSF-only metadata when it is published", () => {
    const model = buildAnalysisResultInspectorModel({
      item: null,
      manifest: manifest("dynamic_structure_factor", {
        array_bounds: "k=[0, 4e7] rad/m; f=[0, 5e9] Hz",
        detrend: "mean",
        mesh_probe_signature: "sha256:probe",
        normalization: "one-sided",
        nyquist_hz: "5e9 Hz",
        phase_convention: "exp[-i(kx-2πft)]",
        sampling_clock: "N_t=256; dt=1e-12 s",
        source_drive: "sinc H_y",
        spatial_axis: "x",
        uniformity_proof: "certified",
        window: "hann",
      }),
    });

    expect(model.metadata).toEqual(expect.arrayContaining([
      { label: "Spatial axis", value: "x" },
      { label: "Phase convention", mono: true, value: "exp[-i(kx-2πft)]" },
      { label: "Probe signature", mono: true, value: "sha256:probe" },
      { label: "Bounds", value: "k=[0, 4e7] rad/m; f=[0, 5e9] Hz" },
    ]));
  });

  it("keeps absent published metadata explicitly unavailable", () => {
    const model = buildAnalysisResultInspectorModel({
      item: null,
      manifest: manifest("time_domain_spectrum", {}),
    });

    expect(model.metadata).toEqual(expect.arrayContaining([
      { label: "Sampling clock", value: "Unavailable" },
      { label: "Uniformity proof", value: "Unavailable" },
      { label: "Nyquist", value: "Unavailable" },
      { label: "Source drive", value: "Unavailable" },
    ]));
  });

  it("marks a relation with a mismatched source revision as stale", () => {
    const model = buildAnalysisResultInspectorModel({
      item: {
        relations: [{
          method: "frequency_and_spatial_overlap.v1",
          qualification: "qualified",
          relation: "matched_eigen_mode",
          score: 0.98,
          source_revision: "sha256:item-stale",
          target_dataset_id: "dataset:eigen",
          target_item_id: "mode:4",
          target_revision: "sha256:eigen",
          target_sample_id: "sample:7",
        }],
        source_revision: "sha256:item-current",
      },
      manifest: manifest("time_domain_spectrum", {}),
    });

    expect(model.relations).toEqual([
      {
        label: "matched_eigen_mode",
        mono: true,
        status: "stale",
        value: "Stale: source revision does not match the selected item",
      },
    ]);
  });

  it("keeps a complete cross-dataset source peak relation available", () => {
    const model = buildAnalysisResultInspectorModel({
      item: {
        relations: [{
          method: "peak_extraction.v1",
          qualification: "validated",
          relation: "source_peak",
          source_revision: "sha256:item-current",
          target_dataset_id: "dataset:peaks",
          target_item_id: "peak:12",
          target_revision: "sha256:peaks",
          target_sample_id: "sample:1",
        }],
        source_revision: "sha256:item-current",
      },
      manifest: manifest("time_domain_spectrum", {}),
    });

    expect(model.relations).toEqual([
      {
        label: "source_peak",
        mono: true,
        status: "ready",
        value: "dataset:peaks · sample:1 · peak:12 · sha256:peaks · peak_extraction.v1 · validated",
      },
    ]);
  });

  it("publishes axis identity and source artifact provenance for every dataset", () => {
    const model = buildAnalysisResultInspectorModel({
      item: null,
      manifest: {
        ...manifest("time_domain_spectrum", { sampling_clock: "N=128; dt=1e-12 s" }),
        axes: [axis],
        source_artifacts: [{
          artifact: "analysis/time-series.zarr",
          relation: "canonical_time_series",
          revision: "sha256:time-series",
        }],
      },
    });

    expect(model.axes).toEqual([
      {
        label: "Bias field",
        mono: true,
        value: "outer_sweep · vector3 · 15 values · A/m · semantic=bias_field_a_per_m",
      },
    ]);
    expect(model.sources).toEqual([
      {
        label: "canonical_time_series",
        mono: true,
        value: "analysis/time-series.zarr · sha256:time-series",
      },
    ]);
  });
});
