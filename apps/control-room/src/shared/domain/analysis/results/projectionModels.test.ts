import { describe, expect, it } from "vitest";

import {
  analysisResultSpectrumOutputScopes,
  buildAnalysisResultProjectionChartModel,
} from "./projectionModels";
import type {
  AnalysisResultDatasetManifestResource,
  AnalysisResultProjectionResource,
} from "./types";

const projection: AnalysisResultProjectionResource = {
  axis_labels: { x: "Bias field", y: "Frequency" },
  axis_mapping: { x: "bias-field", y: "frequency_hz" },
  axis_units: { x: "T", y: "Hz" },
  dataset_id: "dataset:field-sweep",
  dataset_revision: "sha256:dataset",
  fixed_coordinates: [],
  projection_id: "field-frequency-map",
  projection_revision: "sha256:projection",
  run_id: "run:1",
  schema_version: "fullmag.analysis.result_dataset_index.v1",
  selection_index: [
    { branch_id: "branch:0", item_id: "item:0", item_kind: "eigen_mode", ordinal: 10, sample_id: "sample:0" },
    { branch_id: "branch:0", item_id: "item:1", item_kind: "eigen_mode", ordinal: 11, sample_id: "sample:1" },
  ],
  series: [
    {
      label: "branch:0",
      points: [
        { branch_id: "branch:0", item_id: "item:0", ordinal: 10, sample_id: "sample:0", status: "ready", x: 0.01, y: 1e9, value: 1e9 },
        { branch_id: "branch:0", item_id: "item:1", ordinal: 11, sample_id: "sample:1", status: "partial", x: 0.02, y: null, value: null },
      ],
      series_id: "branch:0",
    },
  ],
  status: {
    completeness: "ready",
    detail: null,
    execution: "published",
    qualification: "unvalidated",
    reason_code: null,
    resource: "ready",
  },
  unsupported_reason: null,
};

const modalProjection: AnalysisResultProjectionResource = {
  ...projection,
  axis_labels: { x: "Wavevector", y: "Frequency" },
  axis_mapping: { x: "k_rad_per_m", y: "frequency_hz" },
  axis_units: { x: "rad/m", y: "Hz" },
  selection_index: [
    { branch_id: "branch:0", item_id: "mode:k-negative:0", item_kind: "eigen_mode", ordinal: 0, sample_id: "sample:k-negative" },
    { branch_id: "branch:0", item_id: "mode:k-zero:0", item_kind: "eigen_mode", ordinal: 1, sample_id: "sample:k-zero" },
    { branch_id: "branch:0", item_id: "mode:k-positive:0", item_kind: "eigen_mode", ordinal: 2, sample_id: "sample:k-positive" },
    { branch_id: "branch:1", item_id: "mode:k-negative:1", item_kind: "eigen_mode", ordinal: 3, sample_id: "sample:k-negative" },
    { branch_id: "branch:1", item_id: "mode:k-zero:1", item_kind: "eigen_mode", ordinal: 4, sample_id: "sample:k-zero" },
    { branch_id: "branch:1", item_id: "mode:k-positive:1", item_kind: "eigen_mode", ordinal: 5, sample_id: "sample:k-positive" },
  ],
  series: [
    {
      label: "mode 0",
      points: [
        { branch_id: "branch:0", item_id: "mode:k-negative:0", ordinal: 0, sample_id: "sample:k-negative", status: "ready", value: 1e9, x: -1, y: 1e9 },
        { branch_id: "branch:0", item_id: "mode:k-zero:0", ordinal: 1, sample_id: "sample:k-zero", status: "ready", value: 2e9, x: 0, y: 2e9 },
        { branch_id: "branch:0", item_id: "mode:k-positive:0", ordinal: 2, sample_id: "sample:k-positive", status: "ready", value: 3e9, x: 1, y: 3e9 },
      ],
      series_id: "branch:0",
    },
    {
      label: "mode 1",
      points: [
        { branch_id: "branch:1", item_id: "mode:k-negative:1", ordinal: 3, sample_id: "sample:k-negative", status: "ready", value: 1.5e9, x: -1, y: 1.5e9 },
        { branch_id: "branch:1", item_id: "mode:k-zero:1", ordinal: 4, sample_id: "sample:k-zero", status: "ready", value: 2e9, x: 0, y: 2e9 },
        { branch_id: "branch:1", item_id: "mode:k-positive:1", ordinal: 5, sample_id: "sample:k-positive", status: "ready", value: 3.5e9, x: 1, y: 3.5e9 },
      ],
      series_id: "branch:1",
    },
  ],
};

describe("analysis result projection chart model", () => {
  it("keeps stable ordinal selection alongside bounded chart points", () => {
    const model = buildAnalysisResultProjectionChartModel(projection);
    expect(model.series[0]?.points).toEqual([
      { branchId: "branch:0", itemId: "item:0", label: "item:0", rowIndex: 10, sampleId: "sample:0", x: 0.01, y: 1e9 },
      { branchId: "branch:0", itemId: "item:1", label: "item:1", rowIndex: 11, sampleId: "sample:1", x: 0.02, y: Number.NaN },
    ]);
    expect(model.selectionBySeriesId["field-frequency-map:branch:0"]?.map((entry) => entry.ordinal)).toEqual([10, 11]);
    expect(model.selectionBySeriesId["field-frequency-map:branch:0"]?.map((entry) => entry.item_kind)).toEqual(["eigen_mode", "eigen_mode"]);
    expect(model.series[0]?.xUnit).toBe("T");
    expect(model.series[0]?.unit).toBe("Hz");
  });

  it("does not manufacture a chart point for an unsupported projection", () => {
    const model = buildAnalysisResultProjectionChartModel({
      ...projection,
      series: [{ ...projection.series[0]!, points: [{ ...projection.series[0]!.points[0]!, y: null, value: null }] }],
      unsupported_reason: "observable unavailable",
    });
    expect(model.series[0]?.points[0]?.y).toBe(Number.NaN);
  });

  it("does not manufacture a selection for a point absent from the selection index", () => {
    const model = buildAnalysisResultProjectionChartModel({
      ...projection,
      selection_index: [],
    });

    expect(model.series[0]?.points).toHaveLength(2);
    expect(model.selectionBySeriesId["field-frequency-map:branch:0"]).toEqual([]);
  });

  it("keeps explicit branch gaps when bounding a large projection", () => {
    const points = Array.from({ length: 10_000 }, (_, index) =>
      index === 1
        ? {
            branch_id: "branch:0",
            item_id: null,
            ordinal: index,
            sample_id: null,
            status: "gap",
            value: null,
            x: null,
            y: null,
          }
        : {
            branch_id: "branch:0",
            item_id: `item:${index}`,
            ordinal: index,
            sample_id: `sample:${index}`,
            status: "ready",
            value: index,
            x: index,
            y: index,
          },
    );

    const model = buildAnalysisResultProjectionChartModel({
      ...projection,
      selection_index: [],
      series: [{ ...projection.series[0]!, points }],
    });

    expect(model.series[0]?.points).toHaveLength(5_000);
    expect(model.exportSeries?.[0]?.points).toHaveLength(10_000);
    expect(model.exportSeries?.[0]?.points.at(-1)).toMatchObject({
      itemId: "item:9999",
      rowIndex: 9999,
      sampleId: "sample:9999",
    });
    expect(model.series[0]?.points).toContainEqual({
      branchId: null,
      itemId: null,
      label: "point 1",
      rowIndex: 1,
      sampleId: null,
      x: Number.NaN,
      y: Number.NaN,
    });
  });

  it("uses the spin-wave chart resource kind for time-domain result products", () => {
    const model = buildAnalysisResultProjectionChartModel(
      projection,
      "time_domain_spectrum",
    );
    expect(model.series[0]?.source.kind).toBe("analysis.spin_wave");
    expect(model.series[0]?.sourceIdentity?.provenance).toBe(
      "analysis-result-projection:time_domain_spectrum",
    );
  });

  it("keeps each global k/mode row and degenerate mode identity separate", () => {
    const model = buildAnalysisResultProjectionChartModel(modalProjection, "modal_eigen", {
      requestedSpectrumOutputScopes: ["global"],
    });

    expect(model.scopeView).toEqual({ kind: "global", sampleId: null });
    expect(model.series.map((series) => series.points.map((point) => [point.x, point.y, point.itemId]))).toEqual([
      [[-1, 1e9, "mode:k-negative:0"], [0, 2e9, "mode:k-zero:0"], [1, 3e9, "mode:k-positive:0"]],
      [[-1, 1.5e9, "mode:k-negative:1"], [0, 2e9, "mode:k-zero:1"], [1, 3.5e9, "mode:k-positive:1"]],
    ]);
    expect(model.exportSeries?.reduce((count, series) => count + series.points.length, 0)).toBe(6);
  });

  it("filters a per-sample view by the preserved sample identity without collapsing degenerate modes", () => {
    const model = buildAnalysisResultProjectionChartModel(modalProjection, "modal_eigen", {
      requestedSpectrumOutputScopes: ["per_sample", "global"],
      selectedSampleId: "sample:k-zero",
    });

    expect(model.scopeView).toEqual({ kind: "per_sample", sampleId: "sample:k-zero" });
    expect(model.exportSeries?.map((series) => series.points.map((point) => point.itemId))).toEqual([
      ["mode:k-zero:0"],
      ["mode:k-zero:1"],
    ]);
    expect(model.exportSeries?.flatMap((series) => series.points.map((point) => [point.x, point.y]))).toEqual([
      [0, 2e9],
      [0, 2e9],
    ]);
  });

  it("keeps the requested global collection available while a sample is selected", () => {
    const model = buildAnalysisResultProjectionChartModel(modalProjection, "modal_eigen", {
      requestedSpectrumOutputScopes: ["per_sample", "global"],
      selectedSampleId: "sample:k-zero",
      selectedSpectrumOutputScope: "global",
    });

    expect(model.scopeView).toEqual({ kind: "global", sampleId: null });
    expect(model.exportSeries?.flatMap((series) => series.points.map((point) => point.sampleId))).toEqual([
      "sample:k-negative",
      "sample:k-zero",
      "sample:k-positive",
      "sample:k-negative",
      "sample:k-zero",
      "sample:k-positive",
    ]);
  });

  it("keeps missing scope metadata unknown and explicit empty intent empty", () => {
    const legacyManifest = {
      product_kind: "modal_eigen",
    } as unknown as AnalysisResultDatasetManifestResource;
    const noScopeIntentManifest = {
      product_kind: "modal_eigen",
      spectrum_output_scopes: [],
    } as unknown as AnalysisResultDatasetManifestResource;
    const unknown = buildAnalysisResultProjectionChartModel(modalProjection, "modal_eigen", {
      requestedSpectrumOutputScopes: analysisResultSpectrumOutputScopes(legacyManifest),
      selectedSampleId: "sample:k-zero",
    });
    const empty = buildAnalysisResultProjectionChartModel(modalProjection, "modal_eigen", {
      requestedSpectrumOutputScopes: analysisResultSpectrumOutputScopes(noScopeIntentManifest),
      selectedSampleId: "sample:k-zero",
    });

    expect(unknown.requestedSpectrumOutputScopes).toBeNull();
    expect(unknown.scopeView?.kind).toBe("unknown");
    expect(unknown.exportSeries?.reduce((count, series) => count + series.points.length, 0)).toBe(6);
    expect(empty.requestedSpectrumOutputScopes).toEqual([]);
    expect(empty.scopeView?.kind).toBe("none");
    expect(empty.exportSeries?.reduce((count, series) => count + series.points.length, 0)).toBe(0);
  });
});
