import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";
import { createModeFieldOverlayIntent } from "@/kernel/visualization/ModeFieldOverlayIntent";
import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import { buildEigenDispersionPointSelectionRefFromSelection } from "./FrequencyDomainResultInspectors";

const dispersionPoint: EigenDispersionPoint = {
  analyticFrequencyHz: null,
  branchId: "acoustic",
  frequencyHz: 7.5e9,
  linewidthHz: 2.8e6,
  modeFieldAvailable: true,
  modeFieldId: "analysis:eigen:sample-0000:mode-0002:delta_m_xyz",
  modeFieldResourceKey: "field://analysis/eigen/mode-0002",
  modeId: "mode-0002",
  overlap: 0.97,
  pathS: 1.25e6,
  rawModeIndex: 2,
  relativeError: null,
  residualNorm: 1e-8,
  sampleId: "sample-0000",
  sampleIndex: 0,
  sampleLabel: "G",
  validationGeometry: null,
  wavevectorKf: [0, 0, 0],
};

describe("dispersion Inspector selection handoff", () => {
  it("keeps the current published run, stage, revision and artifact fence on the clicked mode", () => {
    const selection: Selection = {
      ...EMPTY_SELECTION,
      kind: "results.eigen.dispersion",
      label: "Published dispersion",
      nodeId: "results:eigen:dispersion",
      ref: {
        analysisRunId: "run-published-7",
        analysisStageId: "stage-eigen-2",
        datasetId: "catalog:dataset-eigen-2",
        datasetRevision: "catalog-revision-7",
        artifactPath: "results/run-published-7/eigen/dispersion.json",
        artifactRevision: "sha256:published-dispersion-v7",
        kind: "results.eigen.dispersion",
        nodeId: "results:eigen:dispersion",
        resourceRef: "analysis/frequency-domain/eigen/dispersion",
        type: "frequency-domain",
      },
    };

    const ref = buildEigenDispersionPointSelectionRefFromSelection(
      dispersionPoint,
      selection,
    );

    expect(ref).toMatchObject({
      analysisRunId: "run-published-7",
      analysisStageId: "stage-eigen-2",
      datasetId: "catalog:dataset-eigen-2",
      datasetRevision: "catalog-revision-7",
      artifactPath: "results/run-published-7/eigen/dispersion.json",
      artifactRevision: "sha256:published-dispersion-v7",
      fieldId: dispersionPoint.modeFieldId,
      kind: "results.eigen.mode",
      modeId: dispersionPoint.modeId,
      sampleId: dispersionPoint.sampleId,
    });

    const intent = ref.type === "frequency-domain"
      ? createModeFieldOverlayIntent(ref)
      : null;
    expect(intent).toMatchObject({
      analysisRunId: "run-published-7",
      analysisStageId: "stage-eigen-2",
      artifactRevision: "sha256:published-dispersion-v7",
      fieldId: dispersionPoint.modeFieldId,
      modeId: dispersionPoint.modeId,
      sampleId: dispersionPoint.sampleId,
    });
  });

  it("does not invent owner or revision fences when the current selection has no frequency-domain ref", () => {
    const ref = buildEigenDispersionPointSelectionRefFromSelection(
      dispersionPoint,
      {
        ...EMPTY_SELECTION,
        kind: "results.eigen.dispersion",
      },
    );

    expect(ref).not.toHaveProperty("analysisRunId");
    expect(ref).not.toHaveProperty("analysisStageId");
    expect(ref).not.toHaveProperty("artifactRevision");
    expect(ref).not.toHaveProperty("datasetId");
    expect(ref).not.toHaveProperty("datasetRevision");
    expect(ref.type === "frequency-domain" ? createModeFieldOverlayIntent(ref) : null)
      .toBeNull();
  });
});
