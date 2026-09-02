import { describe, expect, it } from "vitest";

import {
  analysisResultDatasetIdentity,
  analysisResultSelectionForProjection,
  analysisResultSelectionEquals,
  analysisResultSelectionRef,
} from "./identity";
import type { AnalysisResultDatasetManifestResource } from "./types";

const manifest = {
  dataset_id: "result:run:stage:field-sweep",
  dataset_revision: "sha256:one",
  run_id: "run:1",
  stage_id: "stage:eigen",
} as AnalysisResultDatasetManifestResource;

describe("analysis result selection identity", () => {
  it("keeps the DOM identity stable when only the resource revision changes", () => {
    const identity = analysisResultDatasetIdentity(manifest);
    const first = analysisResultSelectionRef({
      ...identity,
      focus: "item",
      itemId: "mode:0",
      sampleId: "sample:0",
    });
    const refreshed = analysisResultSelectionRef({
      ...identity,
      datasetRevision: "sha256:two",
      focus: "item",
      itemId: "mode:0",
      sampleId: "sample:0",
    });

    expect(refreshed.nodeId).toBe(first.nodeId);
    expect(analysisResultSelectionEquals(first, refreshed)).toBe(false);
  });

  it("changes only the projection focus when Analysis switches projection resources", () => {
    const selection = analysisResultSelectionRef({
      datasetId: "dataset-1",
      datasetRevision: "revision-1",
      focus: "item",
      itemId: "item-1",
      itemKind: "eigen_mode",
      runId: "run-1",
      sampleId: "sample-1",
      stageId: "stage-1",
    });

    const projected = analysisResultSelectionForProjection(
      selection,
      "modal-spectrum-at-slice",
    );

    expect(projected).toMatchObject({
      datasetId: "dataset-1",
      focus: "item",
      itemId: "item-1",
      projectionId: "modal-spectrum-at-slice",
      sampleId: "sample-1",
    });
    expect(projected.nodeId).not.toBe(selection.nodeId);
  });

  it("canonicalizes multi-axis filters without using display order", () => {
    const first = analysisResultSelectionRef({
      datasetId: "dataset-1",
      datasetRevision: "revision-1",
      axisFilters: { thickness: "thickness:2", bias: "bias:1" },
      focus: "slice",
      runId: "run-1",
      stageId: "stage-1",
    });
    const reordered = analysisResultSelectionRef({
      datasetId: "dataset-1",
      datasetRevision: "revision-1",
      axisFilters: { bias: "bias:1", thickness: "thickness:2" },
      focus: "slice",
      runId: "run-1",
      stageId: "stage-1",
    });

    expect(first.nodeId).toBe(reordered.nodeId);
    expect(analysisResultSelectionEquals(first, reordered)).toBe(true);
  });
});
