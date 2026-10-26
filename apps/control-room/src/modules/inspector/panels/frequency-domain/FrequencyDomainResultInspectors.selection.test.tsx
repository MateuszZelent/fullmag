import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";
import { createModeFieldOverlayIntent } from "@/kernel/visualization/ModeFieldOverlayIntent";
import {
  frequencyDomainResultContextFromManifest,
  type EigenDispersionPoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

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

function dispersionResultContext(
  samples: readonly Record<string, unknown>[],
) {
  return frequencyDomainResultContextFromManifest({
    boundary_context: "floquet_periodic",
    geometry_identity: "geometry-1",
    k_sampling: { kind: "path", sample_count: 2 },
    mesh_identity: "mesh-1",
    run_id: "run-published-7",
    stage_id: "stage-eigen-2",
    study_product: "modal_eigen",
    sample_execution_provenance: {
      schema_version: "frequency_domain_sample_execution_provenance.v1",
      status: "mixed",
      sample_count: 2,
      samples,
    },
  }, {
    runId: "run-published-7",
    stageId: "stage-eigen-2",
  });
}

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
        equilibriumId: "stale-equilibrium-from-previous-sample",
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
      dispersionResultContext([
        { sample_index: 0, validation: { equilibrium_artifact_sha256: "equilibrium-sample-0000" } },
        { sample_index: 1, validation: { equilibrium_artifact_sha256: "equilibrium-sample-0001" } },
      ]),
    );

    expect(ref).toMatchObject({
      analysisRunId: "run-published-7",
      analysisStageId: "stage-eigen-2",
      datasetId: "catalog:dataset-eigen-2",
      datasetRevision: "catalog-revision-7",
      artifactPath: "results/run-published-7/eigen/dispersion.json",
      artifactRevision: "sha256:published-dispersion-v7",
      equilibriumId: "equilibrium-sample-0000",
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
      equilibriumId: "equilibrium-sample-0000",
      fieldId: dispersionPoint.modeFieldId,
      modeId: dispersionPoint.modeId,
      sampleId: dispersionPoint.sampleId,
    });
  });

  it("resolves the newly selected sample instead of reusing the prior sample equilibrium", () => {
    const selection: Selection = {
      ...EMPTY_SELECTION,
      kind: "results.eigen.mode",
      label: "Previously selected sample 0",
      nodeId: "results:eigen:sample:0:mode:2",
      ref: {
        analysisRunId: "run-published-7",
        analysisStageId: "stage-eigen-2",
        equilibriumId: "equilibrium-sample-0000",
        artifactPath: "results/run-published-7/eigen/dispersion.json",
        artifactRevision: "sha256:published-dispersion-v7",
        kind: "results.eigen.mode",
        nodeId: "results:eigen:sample:0:mode:2",
        type: "frequency-domain",
      },
    };
    const sampleOnePoint: EigenDispersionPoint = {
      ...dispersionPoint,
      modeFieldId: "analysis:eigen:sample-0001:mode-0002:delta_m_xyz",
      modeFieldResourceKey: "field://analysis/eigen/mode-0002-sample-1",
      modeId: "sample-0001/mode-0002",
      sampleId: "sample-0001",
      sampleIndex: 1,
    };

    const ref = buildEigenDispersionPointSelectionRefFromSelection(
      sampleOnePoint,
      selection,
      dispersionResultContext([
        { sample_index: 0, validation: { equilibrium_artifact_sha256: "equilibrium-sample-0000" } },
        { sample_index: 1, validation: { equilibrium_artifact_sha256: "equilibrium-sample-0001" } },
      ]),
    );

    expect(ref).toMatchObject({
      equilibriumId: "equilibrium-sample-0001",
      fieldId: sampleOnePoint.modeFieldId,
      modeId: "sample-0001/mode-0002",
      sampleId: "sample-0001",
      sampleIndex: 1,
    });
    expect(ref.type === "frequency-domain" ? createModeFieldOverlayIntent(ref) : null)
      .toMatchObject({ equilibriumId: "equilibrium-sample-0001" });
  });

  it("removes field selection when per-sample equilibrium is missing or no manifest is available", () => {
    const selection: Selection = {
      ...EMPTY_SELECTION,
      kind: "results.eigen.mode",
      label: "Previously selected sample 0",
      nodeId: "results:eigen:sample:0:mode:2",
      ref: {
        analysisRunId: "run-published-7",
        analysisStageId: "stage-eigen-2",
        equilibriumId: "equilibrium-sample-0000",
        artifactPath: "results/run-published-7/eigen/dispersion.json",
        artifactRevision: "sha256:published-dispersion-v7",
        kind: "results.eigen.mode",
        nodeId: "results:eigen:sample:0:mode:2",
        type: "frequency-domain",
      },
    };
    const missingSampleEquilibrium = dispersionResultContext([
      { sample_index: 0, validation: { equilibrium_artifact_sha256: "equilibrium-sample-0000" } },
      { sample_index: 1, validation: {} },
    ]);

    for (const resultContext of [missingSampleEquilibrium, null]) {
      const ref = buildEigenDispersionPointSelectionRefFromSelection(
        { ...dispersionPoint, sampleId: "sample-0001", sampleIndex: 1 },
        selection,
        resultContext,
      );

      expect(ref).not.toHaveProperty("fieldId");
      expect(ref).not.toHaveProperty("equilibriumId");
      expect(ref.type === "frequency-domain" ? createModeFieldOverlayIntent(ref) : null)
        .toBeNull();
    }
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
