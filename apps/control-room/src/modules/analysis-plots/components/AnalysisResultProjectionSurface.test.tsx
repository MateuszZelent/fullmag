import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import {
  analysisResultSelectionRef,
  buildAnalysisResultProjectionChartModel,
  type AnalysisResultProjectionResource,
} from "@/shared/domain/analysis/results";

const chartMocks = vi.hoisted(() => ({
  onPointSelect: null as
    | ((point: { seriesId: string; point: { rowIndex: number } }) => void)
    | null,
}));

vi.mock("./EChartsSurface", () => ({
  EChartsSurface: (props: {
    onPointSelect?: (point: { seriesId: string; point: { rowIndex: number } }) => void;
  }) => {
    chartMocks.onPointSelect = props.onPointSelect ?? null;
    return null;
  },
}));

import { AnalysisResultProjectionSurface } from "./AnalysisResultProjectionSurface";

describe("AnalysisResultProjectionSurface", () => {
  it("uses the clicked projection entry item_kind instead of the previous selection", () => {
    const resource = {
      axis_labels: { x: "Wavevector", y: "Frequency" },
      axis_mapping: { x: "k_rad_per_m", y: "frequency_hz" },
      axis_units: { x: "rad/m", y: "Hz" },
      dataset_id: "result:run-1:stage-1:dynamic-structure-factor",
      dataset_revision: "revision-1",
      fixed_coordinates: [],
      projection_id: "dsf-map",
      projection_revision: "projection-revision-1",
      run_id: "run-1",
      schema_version: "fullmag.analysis.result_dataset_index.v1",
      selection_index: [
        {
          branch_id: null,
          item_id: "legacy:dsf:0:0",
          item_kind: "dsf_point",
          ordinal: 0,
          sample_id: "dsf-sample-0000",
        },
      ],
      series: [
        {
          label: "S(k, f)",
          points: [
            {
              branch_id: null,
              item_id: "legacy:dsf:0:0",
              ordinal: 0,
              sample_id: "dsf-sample-0000",
              status: "partial",
              value: 1,
              x: 10,
              y: 2e9,
            },
          ],
          series_id: "dsf",
        },
      ],
      status: {
        completeness: "partial",
        detail: null,
        execution: "published",
        qualification: "legacy",
        reason_code: null,
        resource: "ready",
      },
      unsupported_reason: null,
    } as unknown as AnalysisResultProjectionResource;
    const onPointSelect = vi.fn();
    const model = buildAnalysisResultProjectionChartModel(
      resource,
      "dynamic_structure_factor",
    );
    const selectedSelection = analysisResultSelectionRef({
      datasetId: resource.dataset_id,
      datasetRevision: resource.dataset_revision,
      focus: "item",
      itemId: "legacy:eigen:mode:0",
      itemKind: "eigen_mode",
      runId: resource.run_id,
      sampleId: "eigen-sample-0000",
      stageId: "stage-1",
    });

    renderToStaticMarkup(
      <AnalysisResultProjectionSurface
        kernel={{ bus: undefined } as unknown as KernelApi}
        model={model}
        onPointSelect={onPointSelect}
        onProjectionSelect={() => undefined}
        projections={[]}
        productKind="dynamic_structure_factor"
        resource={resource}
        selectedProjectionId="dsf-map"
        selectedSelection={selectedSelection}
        status="ready"
      />,
    );

    expect(chartMocks.onPointSelect).not.toBeNull();
    chartMocks.onPointSelect?.({
      point: { rowIndex: 0 },
      seriesId: "dsf-map:dsf",
    });

    expect(onPointSelect).toHaveBeenCalledWith({
      branchId: null,
      itemId: "legacy:dsf:0:0",
      itemKind: "dsf_point",
      ordinal: 0,
      sampleId: "dsf-sample-0000",
    });
  });
});
