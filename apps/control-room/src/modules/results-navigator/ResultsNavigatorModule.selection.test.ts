import { describe, expect, it } from "vitest";

import type { AnalysisResultDatasetManifestResource } from "@/kernel/api/apiTypes";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

import { resultSelectionForAnalysis } from "./ResultsNavigatorModule";

const manifest = {
  dataset_id: "result:run-1:stage-1:modal-eigen-field-sweep",
  dataset_revision: "dataset-revision-1",
  run_id: "run-1",
  stage_id: "stage-1",
} as AnalysisResultDatasetManifestResource;

describe("resultSelectionForAnalysis", () => {
  it("selects the manifest dataset when Analysis is opened without a selection", () => {
    expect(resultSelectionForAnalysis(manifest, null)).toMatchObject({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      focus: "dataset",
      runId: manifest.run_id,
      stageId: manifest.stage_id,
    });
  });

  it("preserves an item selection from the same immutable dataset", () => {
    const selection = analysisResultSelectionRef({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      focus: "item",
      itemId: "sample-0007/mode-0002",
      itemKind: "eigen_mode",
      runId: manifest.run_id,
      sampleId: "bias-field-sample-0007",
      stageId: manifest.stage_id,
    });

    expect(resultSelectionForAnalysis(manifest, selection)).toBe(selection);
  });

  it("replaces a selection from another dataset with the manifest dataset", () => {
    const foreign = analysisResultSelectionRef({
      datasetId: "result:foreign",
      datasetRevision: "foreign-revision",
      focus: "item",
      itemId: "foreign-item",
      runId: "run-foreign",
      stageId: "stage-foreign",
    });

    expect(resultSelectionForAnalysis(manifest, foreign)).toMatchObject({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      focus: "dataset",
      runId: manifest.run_id,
      stageId: manifest.stage_id,
    });
  });

  it("returns null while the manifest is unavailable", () => {
    expect(resultSelectionForAnalysis(null, null)).toBeNull();
  });
});
