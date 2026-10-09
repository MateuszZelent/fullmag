import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
} from "@/kernel/api/apiPaths";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import type { EigenBranchPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import {
  buildEigenBranchResultManifestOwner,
  buildEigenBranchModePlotHandoff,
  buildEigenBranchPointViewModel,
} from "./EigenBranchInspectorPanel";

const point: EigenBranchPoint = {
  frequencyImagHz: -14e6,
  frequencyRealHz: 13.1e9,
  modeFieldId: null,
  modeFieldResourceKey: null,
  overlapPrev: 0.97,
  rawModeIndex: 1,
  residualNorm: 2e-8,
  sampleIndex: 1,
  trackingConfidence: 0.98,
};

function modalManifestResource(
  owner: Partial<{
    artifact_set_id: string;
    run_id: string;
    session_id: string;
    stage_id: string;
  }> = {},
) {
  return {
    result_manifest: {
      artifact_path: "manifest.v1.json",
      artifact_set_id: owner.artifact_set_id ?? "sha256:artifact-set-7",
      content_digest: "sha256:manifest-bytes-7",
      payload: {
        equilibrium_identity: "equilibrium-7",
        geometry_identity: "geometry-7",
        mesh_identity: "mesh-7",
        normalization: "unit_l2",
        requested_execution: {
          boundary_context: "floquet_periodic",
          k_sampling: { kind: "path", label: "Γ–X", sample_count: 2 },
        },
        run_id: "current",
        stage_id: "eigenmodes",
        study_product: "modal_eigen",
      },
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      revision: "sha256:manifest-revision-7",
      run_id: owner.run_id ?? "run-7",
      schema_version: "frequency_domain_manifest.v1",
      session_id: owner.session_id ?? "session-7",
      stage_id: owner.stage_id ?? "eigen-stage-7",
      status: "ready",
    },
  };
}

const modalManifestOwner = buildEigenBranchResultManifestOwner(
  modalManifestResource(),
);

describe("EigenBranchInspectorPanel point model", () => {
  it("preserves branch, sample, mode and missing-field identity", () => {
    expect(buildEigenBranchPointViewModel("acoustic", point)).toEqual({
      branchId: "acoustic",
      fieldAvailable: false,
      frequencyHz: 13.1e9,
      modeIndex: 1,
      pointId: "results:eigen:branch:acoustic:sample:1:mode:1",
      sampleIndex: 1,
    });
  });

  it("binds a 3D handoff to the clicked point and its ready artifact owner", () => {
    const plotPoint: EigenBranchPoint = {
      ...point,
      frequencyRealHz: 13.1e9,
      modeFieldAvailable: true,
      modeFieldId: "analysis:eigen:sample-0001:mode-0001",
      modeFieldResourceKey:
        "data/fields/analysis%3Aeigen%3Asample-0001%3Amode-0001?view=phase_rotated_real&phase_rad=0",
      modeId: "mode-0001",
      pathS: 1.25e7,
      sampleId: "sample-0001",
      wavevectorKf: [1.25e7, 0, 0],
    };
    expect(modalManifestOwner?.resultContext.runId).toBe("run-7");
    expect(modalManifestOwner?.resultContext.stageId).toBe("eigen-stage-7");
    expect(modalManifestOwner?.resultContext.classification?.kContext.kind).toBe(
      "k_path",
    );
    const handoff = buildEigenBranchModePlotHandoff(
      "acoustic",
      plotPoint,
      "ready",
      {
        artifact_path: "eigen/branches.v2.json",
        artifact_set_id: "sha256:artifact-set-7",
        content_digest: "sha256:branches-bytes-7",
        mesh_generation_id: "mesh-7",
        resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
        revision: "sha256:branches-revision-7",
        run_id: "run-7",
        schema_version: "frequency_domain_eigen_branches.v2",
        session_id: "session-7",
        stage_id: "eigen-stage-7",
        status: "ready",
      },
      "ready",
      modalManifestOwner,
    );

    expect(handoff?.commandInput).toMatchObject({
      artifactRevision: "sha256:branches-revision-7",
      fieldId: "analysis:eigen:sample-0001:mode-0001",
      frequencyHz: 13.1e9,
      equilibriumId: "equilibrium-7",
      kContextKind: "k_path",
      kPathCoordinateRadPerM: 1.25e7,
      modeIndex: 1,
      normalization: "unit_l2",
      representation: "complex-vector-xyz",
      resourceRef: plotPoint.modeFieldResourceKey,
      runId: "run-7",
      sampleIndex: 1,
      source: "eigen-mode",
      stageId: "eigen-stage-7",
      studyProduct: "modal_eigen",
      view: "phase_rotated_real",
      wavevectorKf: [1.25e7, 0, 0],
    });
    expect(handoff?.selectionRef).toMatchObject({
      analysisRunId: "run-7",
      analysisStageId: "eigen-stage-7",
      artifactPath: "eigen/branches.v2.json",
      artifactRevision: "sha256:branches-revision-7",
      branchId: "acoustic",
      equilibriumId: "equilibrium-7",
      fieldId: "analysis:eigen:sample-0001:mode-0001",
      frequencyHz: 13.1e9,
      kContextKind: "k_path",
      modeId: "mode-0001",
      modeIndex: 1,
      normalization: "unit_l2",
      representation: "complex-vector-xyz",
      resourceRef: plotPoint.modeFieldResourceKey,
      sampleId: "sample-0001",
      sampleIndex: 1,
      studyProduct: "modal_eigen",
    });
  });

  it("does not create a plot handoff without a current complete owner", () => {
    const plotPoint: EigenBranchPoint = {
      ...point,
      modeFieldAvailable: true,
      modeFieldId: "analysis:eigen:sample-0001:mode-0001",
      modeFieldResourceKey: "data/fields/analysis%3Aeigen%3Asample-0001%3Amode-0001",
      modeId: "mode-0001",
      sampleId: "sample-0001",
    };
    const artifact: FrequencyDomainJsonArtifactResource = {
      artifact_set_id: "sha256:artifact-set-7",
      artifact_path: "eigen/branches.v2.json",
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
      revision: "sha256:branches-revision-7",
      run_id: "run-7",
      schema_version: "frequency_domain_eigen_branches.v2",
      session_id: "session-7",
      stage_id: "eigen-stage-7",
      status: "ready",
    };
    const baselinePoint = {
      ...plotPoint,
      pathS: 1.25e7,
      wavevectorKf: [1.25e7, 0, 0] as const,
    };
    const baseline = buildEigenBranchModePlotHandoff(
      "acoustic",
      baselinePoint,
      "ready",
      artifact,
      "ready",
      modalManifestOwner,
    );
    expect(baseline).not.toBeNull();

    for (const resourceStatus of ["ready", "stale"]) {
      for (const manifestStatus of ["ready", "stale"]) {
        expect(
          buildEigenBranchModePlotHandoff(
            "acoustic", baselinePoint, resourceStatus, artifact,
            manifestStatus, modalManifestOwner,
          ),
        ).toEqual(baseline);
      }
    }
    for (const unavailableStatus of ["idle", "loading", "error"]) {
      expect(
        buildEigenBranchModePlotHandoff(
          "acoustic", baselinePoint, unavailableStatus, artifact,
          "stale", modalManifestOwner,
        ),
      ).toBeNull();
      expect(
        buildEigenBranchModePlotHandoff(
          "acoustic", baselinePoint, "stale", artifact,
          unavailableStatus, modalManifestOwner,
        ),
      ).toBeNull();
    }
    for (const changedOwner of [
      { session_id: "other-session" },
      { artifact_set_id: "sha256:other-set" },
      { run_id: "other-run" },
      { stage_id: "other-stage" },
    ]) {
      expect(
        buildEigenBranchModePlotHandoff(
          "acoustic", baselinePoint, "stale", artifact, "stale",
          buildEigenBranchResultManifestOwner(modalManifestResource(changedOwner)),
        ),
      ).toBeNull();
    }
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic", baselinePoint, "stale", null, "stale", modalManifestOwner,
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic", baselinePoint, "stale", { ...artifact, status: "missing" },
        "stale", modalManifestOwner,
      ),
    ).toBeNull();
    const incompleteArtifacts: FrequencyDomainJsonArtifactResource[] = [
      { ...artifact, run_id: null },
      { ...artifact, session_id: null },
      { ...artifact, artifact_set_id: null },
    ];
    for (const incompleteArtifact of incompleteArtifacts) {
      expect(
        buildEigenBranchModePlotHandoff(
          "acoustic",
          baselinePoint,
          "ready",
          incompleteArtifact,
          "ready",
          modalManifestOwner,
        ),
      ).toBeNull();
    }
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        { ...baselinePoint, modeId: null },
        "ready",
        artifact,
        "ready",
        modalManifestOwner,
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        { ...baselinePoint, wavevectorKf: undefined },
        "ready",
        artifact,
        "ready",
        modalManifestOwner,
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        { ...baselinePoint, pathS: undefined },
        "ready",
        artifact,
        "ready",
        modalManifestOwner,
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        baselinePoint,
        "ready",
        { ...artifact, stage_id: "other-stage" },
        "ready",
        modalManifestOwner,
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        baselinePoint,
        "ready",
        artifact,
        "ready",
        buildEigenBranchResultManifestOwner(
          modalManifestResource({ session_id: "other-session" }),
        ),
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        baselinePoint,
        "ready",
        artifact,
        "ready",
        buildEigenBranchResultManifestOwner(
          modalManifestResource({ artifact_set_id: "sha256:other-set" }),
        ),
      ),
    ).toBeNull();
    expect(
      buildEigenBranchModePlotHandoff(
        "acoustic",
        baselinePoint,
        "ready",
        artifact,
        "ready",
        buildEigenBranchResultManifestOwner(
          modalManifestResource({ run_id: "run-other" }),
        ),
      ),
    ).toBeNull();
  });
});
