import { describe, expect, it } from "vitest";

import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { createAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import {
  analysisResultProjectionMatchesSelection,
  analysisResultSelectionOwnsOverlay,
} from "./useAnalysisResultProjectionController";
import {
  analysisResultSelectionRef,
  type AnalysisResultDatasetManifestResource,
  type AnalysisResultProjectionResource,
} from "@/shared/domain/analysis/results";

const projectionIdentity = {
  dataset_id: "result:dataset-1",
  dataset_revision: "dataset-revision-1",
  run_id: "run-1",
} satisfies Pick<
  AnalysisResultProjectionResource,
  "dataset_id" | "dataset_revision" | "run_id"
>;

const manifestIdentity = {
  dataset_id: "result:dataset-1",
  dataset_revision: "dataset-revision-1",
  run_id: "run-1",
} satisfies Pick<
  AnalysisResultDatasetManifestResource,
  "dataset_id" | "dataset_revision" | "run_id"
>;

const fieldRef = {
  field_id: "analysis:eigen:sample-1:mode-1",
  field_revision: "field-revision-1",
  mesh_ref: {
    mesh_id: "mesh-1",
    mesh_revision: "mesh-revision-1",
    topology_fingerprint: "sha256:topology-1",
  },
  quantity_id: "m",
  representation: "complex-vector-xyz",
  resource_key: "data/fields/result-field-1",
  status: "ready",
} as const;

function resultSelection() {
  return analysisResultSelectionRef({
    datasetId: "result:dataset-1",
    datasetRevision: "dataset-revision-1",
    fieldId: fieldRef.field_id,
    fieldRef,
    fieldRevision: fieldRef.field_revision,
    focus: "item",
    itemId: "mode-1",
    itemKind: "eigen_mode",
    runId: "run-1",
    sampleId: "sample-1",
    stageId: "stage-1",
  });
}

function resultOverlay(): AnalysisFieldOverlayState {
  const selection = resultSelection();
  const intent = createAnalysisResultFieldOverlayIntent(selection)!;
  return {
    analysisResultFieldIntent: intent,
    fieldId: intent.fieldId,
    label: "Mode 1",
    query: { component: "full", scope_kind: "full", view: "abs" },
    source: intent.source,
    visualizationPhaseRad: 0,
    provenance: {
      datasetId: intent.datasetId,
      datasetRevision: intent.datasetRevision,
      fieldRevision: intent.fieldRevision,
      representation: "complex-vector-xyz",
      runId: intent.analysisRunId,
      stageId: intent.analysisStageId,
    },
  };
}

describe("analysis result projection overlay ownership", () => {
  it("keeps a typed result overlay owned by the selected dataset item", () => {
    expect(analysisResultSelectionOwnsOverlay(resultSelection(), resultOverlay())).toBe(true);
  });

  it("rejects the same item when its dataset revision changes", () => {
    const selection = resultSelection();
    expect(
      analysisResultSelectionOwnsOverlay(
        { ...selection, datasetRevision: "dataset-revision-2" },
        resultOverlay(),
      ),
    ).toBe(false);
  });
});

describe("analysis result projection identity gate", () => {
  it("accepts a projection matching the selected dataset manifest", () => {
    expect(
      analysisResultProjectionMatchesSelection(
        projectionIdentity,
        resultSelection(),
        manifestIdentity,
      ),
    ).toBe(true);
  });

  it("rejects a projection from an older dataset revision", () => {
    expect(
      analysisResultProjectionMatchesSelection(
        { ...projectionIdentity, dataset_revision: "dataset-revision-0" },
        resultSelection(),
        manifestIdentity,
      ),
    ).toBe(false);
  });

  it.each([
    ["run", { run_id: "run-foreign" }],
    ["dataset", { dataset_id: "result:dataset-foreign" }],
  ] as const)("rejects a projection with a foreign %s identity", (_label, patch) => {
    expect(
      analysisResultProjectionMatchesSelection(
        { ...projectionIdentity, ...patch },
        resultSelection(),
        manifestIdentity,
      ),
    ).toBe(false);
  });

  it("rejects a projection until the matching manifest is available", () => {
    expect(
      analysisResultProjectionMatchesSelection(
        projectionIdentity,
        resultSelection(),
        null,
      ),
    ).toBe(false);
  });
});
