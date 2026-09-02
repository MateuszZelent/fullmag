import { describe, expect, it } from "vitest";

import { buildAnalysisResultProjectionChartModel } from "./projectionModels";
import type { AnalysisResultProjectionResource } from "./types";

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
    { branch_id: "branch:0", item_id: "item:0", ordinal: 10, sample_id: "sample:0" },
    { branch_id: "branch:0", item_id: "item:1", ordinal: 11, sample_id: "sample:1" },
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

describe("analysis result projection chart model", () => {
  it("keeps stable ordinal selection alongside bounded chart points", () => {
    const model = buildAnalysisResultProjectionChartModel(projection);
    expect(model.series[0]?.points).toEqual([
      { label: "item:0", rowIndex: 10, x: 0.01, y: 1e9 },
      { label: "item:1", rowIndex: 11, x: 0.02, y: Number.NaN },
    ]);
    expect(model.selectionBySeriesId["field-frequency-map:branch:0"]?.map((entry) => entry.ordinal)).toEqual([10, 11]);
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
});
