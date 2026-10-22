import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
} from "@/kernel/api/apiPaths";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { EigenBranchPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

const panelMocks = vi.hoisted(() => ({
  branchArtifact: null as unknown,
  branchStatus: "ready" as string,
  copyTextToClipboard: vi.fn(async (_text: string): Promise<void> => undefined),
  executeCommand: vi.fn(),
  manifest: null as unknown,
  manifestStatus: "ready" as string,
  setSelection: vi.fn(),
}));

vi.mock("@/shared/browser/copyTextToClipboard", () => ({
  copyTextToClipboard: panelMocks.copyTextToClipboard,
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
  useKernel: () => ({
    commands: { execute: panelMocks.executeCommand },
    selection: { set: panelMocks.setSelection },
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/studyRuntimeResources")>()),
  useFrequencyDomainManifestResource: () => ({
    data: panelMocks.manifest as never,
    status: panelMocks.manifestStatus as never,
  }),
  useFrequencyDomainEigenBranchesResource: () => ({
    data: panelMocks.branchArtifact as never,
    status: panelMocks.branchStatus as never,
  }),
  useFrequencyDomainEigenDispersionResource: () => ({
    data: null,
    status: "idle",
  }),
}));

import {
  EigenBranchInspectorPanel,
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
    const datasetIdentity = {
      datasetId: "dataset-canonical",
      datasetRevision: "sha256:dataset-revision",
    };
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
      datasetIdentity,
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
      datasetId: "dataset-canonical",
      datasetRevision: "sha256:dataset-revision",
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

    for (const resourceStatus of ["ready", "stale", "error"]) {
      for (const manifestStatus of ["ready", "stale", "error"]) {
        expect(
          buildEigenBranchModePlotHandoff(
            "acoustic", baselinePoint, resourceStatus, artifact,
            manifestStatus, modalManifestOwner,
          ),
        ).toEqual(baseline);
      }
    }
    for (const unavailableStatus of ["idle", "loading"]) {
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
    for (const retainedStatus of ["stale", "error"]) {
      expect(buildEigenBranchModePlotHandoff(
        "acoustic", baselinePoint, retainedStatus, null,
        retainedStatus, modalManifestOwner,
      )).toBeNull();
      expect(buildEigenBranchModePlotHandoff(
        "acoustic", baselinePoint, retainedStatus, artifact,
        retainedStatus, null,
      )).toBeNull();
      expect(buildEigenBranchModePlotHandoff(
        "acoustic", baselinePoint, retainedStatus, { ...artifact, status: "missing" },
        retainedStatus, modalManifestOwner,
      )).toBeNull();
      expect(buildEigenBranchModePlotHandoff(
        "acoustic", baselinePoint, retainedStatus, artifact,
        retainedStatus,
        buildEigenBranchResultManifestOwner(modalManifestResource({ session_id: "other-session" })),
      )).toBeNull();
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

afterEach(() => {
  panelMocks.branchArtifact = null;
  panelMocks.branchStatus = "ready";
  panelMocks.copyTextToClipboard.mockReset();
  panelMocks.copyTextToClipboard.mockResolvedValue(undefined);
  panelMocks.manifest = null;
  panelMocks.manifestStatus = "ready";
  panelMocks.executeCommand.mockClear();
  panelMocks.setSelection.mockClear();
});

describe("EigenBranchInspectorPanel open mode owner binding", () => {
  it("opens a row with the exact ready artifact owner", async () => {
    configurePanelResources();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <EigenBranchInspectorPanel selection={branchInspectorSelection()} />,
        ),
      );

      await act(async () =>
        findButton(container, "Open sample 1 mode 1").click(),
      );

      expect(panelMocks.setSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "results.eigen.mode",
          nodeId: expect.any(String),
          ref: expect.objectContaining({
            analysisRunId: "run-7",
            analysisStageId: "eigen-stage-7",
            datasetId: "dataset-canonical",
            datasetRevision: "sha256:dataset-revision",
            artifactPath: "eigen/branches.v2.json",
            artifactRevision: "sha256:branches-revision-7",
            branchId: "acoustic",
            equilibriumId: "equilibrium-7",
            fieldId: "analysis:eigen:sample-0001:mode-0001",
            modeIndex: 1,
            sampleIndex: 1,
            studyProduct: "modal_eigen",
            type: "frequency-domain",
          }),
        }),
        "inspector",
      );
      expect(panelMocks.executeCommand).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps metadata selection available when the mode field is absent", async () => {
    configurePanelResources({ modeFieldAvailable: false });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <EigenBranchInspectorPanel selection={branchInspectorSelection()} />,
        ),
      );

      const openButton = findButton(container, "Open sample 1 mode 1");
      expect(openButton.disabled).toBe(false);
      await act(async () => openButton.click());

      expect(panelMocks.setSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: expect.objectContaining({
            analysisRunId: "run-7",
            analysisStageId: "eigen-stage-7",
            artifactPath: "eigen/branches.v2.json",
            artifactRevision: "sha256:branches-revision-7",
            modeIndex: 1,
            sampleIndex: 1,
            type: "frequency-domain",
          }),
        }),
        "inspector",
      );
      const selection = panelMocks.setSelection.mock.calls[0]?.[0];
      expect(selection?.ref).not.toHaveProperty("fieldId");
      expect(selection?.ref).not.toHaveProperty("resourceRef");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([
    ["resource is still loading", { branchStatus: "loading" }, {}],
    ["artifact belongs to another run", {}, { runId: "other-run" }],
  ] as const)(
    "does not open a row when its owner is not ready or mismatched: %s",
    async (_label, resourceOptions, artifactOptions) => {
      configurePanelResources({ ...resourceOptions, ...artifactOptions });
      const dom = installSimulationPreparationTestDom();
      const container = dom.document.createElement("div");
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () =>
          root.render(
            <EigenBranchInspectorPanel selection={branchInspectorSelection()} />,
          ),
        );

        const openButton = findButton(container, "Open sample 1 mode 1");
        expect(openButton.disabled).toBe(true);
        await act(async () => openButton.click());
        expect(panelMocks.setSelection).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        dom.restore();
      }
    },
  );
});

describe("EigenBranchInspectorPanel branch CSV clipboard feedback", () => {
  it("shows pending feedback and reports a rejected clipboard write", async () => {
    configurePanelResources();
    const copy = deferredPromise<void>();
    panelMocks.copyTextToClipboard.mockReturnValue(copy.promise);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <EigenBranchInspectorPanel selection={branchInspectorSelection()} />,
        ),
      );

      const copyButton = findButton(container, "Copy branch CSV");
      await act(async () => copyButton.click());

      expect(
        findRoleMessage(container, "status", "Copying branch CSV…"),
      ).not.toBeNull();
      expect(copyButton.disabled).toBe(true);

      await act(async () => {
        copy.reject(new Error("Clipboard permission denied"));
        await copy.promise.catch(() => undefined);
      });

      expect(
        findRoleMessage(
          container,
          "alert",
          "Could not copy branch CSV. Check clipboard permissions and try again.",
        ),
      ).not.toBeNull();
      expect(findRoleMessage(container, "status", "Branch CSV copied.")).toBeNull();
      expect(findButton(container, "Copy branch CSV").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reports when branch CSV has been copied", async () => {
    configurePanelResources();
    panelMocks.copyTextToClipboard.mockResolvedValue(undefined);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <EigenBranchInspectorPanel selection={branchInspectorSelection()} />,
        ),
      );

      await act(async () =>
        findButton(container, "Copy branch CSV").click(),
      );

      expect(
        findRoleMessage(container, "status", "Branch CSV copied."),
      ).not.toBeNull();
      expect(
        findRoleMessage(
          container,
          "alert",
          "Could not copy branch CSV. Check clipboard permissions and try again.",
        ),
      ).toBeNull();
      expect(panelMocks.copyTextToClipboard).toHaveBeenCalledWith(
        expect.stringContaining(
          "branch_id,sample_index,sample_id,raw_mode_index,mode_id",
        ),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late clipboard %s after the artifact and dataset identity change",
    async (settlement) => {
      configurePanelResources();
      const copy = deferredPromise<void>();
      panelMocks.copyTextToClipboard.mockReturnValue(copy.promise);
      const dom = installSimulationPreparationTestDom();
      const container = dom.document.createElement("div");
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () =>
          root.render(
            <EigenBranchInspectorPanel selection={branchInspectorSelection()} />,
          ),
        );

        await act(async () =>
          findButton(container, "Copy branch CSV").click(),
        );
        expect(
          findRoleMessage(container, "status", "Copying branch CSV…"),
        ).not.toBeNull();

        configurePanelResources({
          artifactRevision: "sha256:branches-revision-next",
          manifestRunId: "run-next",
          manifestSessionId: "session-next",
          manifestStageId: "eigen-stage-next",
          runId: "run-next",
          sessionId: "session-next",
          stageId: "eigen-stage-next",
        });
        await act(async () =>
          root.render(
            <EigenBranchInspectorPanel
              selection={branchInspectorSelection({
                datasetId: "dataset-next",
                datasetRevision: "sha256:dataset-revision-next",
              })}
            />,
          ),
        );

        expect(
          findRoleMessage(container, "status", "Copying branch CSV…"),
        ).toBeNull();
        expect(
          findRoleMessage(container, "status", "Branch CSV copied."),
        ).toBeNull();
        expect(
          findRoleMessage(
            container,
            "alert",
            "Could not copy branch CSV. Check clipboard permissions and try again.",
          ),
        ).toBeNull();
        expect(findButton(container, "Copy branch CSV").disabled).toBe(false);

        await act(async () => {
          if (settlement === "resolve") {
            copy.resolve(undefined);
          } else {
            copy.reject(new Error("Clipboard permission denied"));
          }
          await copy.promise.catch(() => undefined);
        });

        expect(
          findRoleMessage(container, "status", "Copying branch CSV…"),
        ).toBeNull();
        expect(
          findRoleMessage(container, "status", "Branch CSV copied."),
        ).toBeNull();
        expect(
          findRoleMessage(
            container,
            "alert",
            "Could not copy branch CSV. Check clipboard permissions and try again.",
          ),
        ).toBeNull();
        expect(findButton(container, "Copy branch CSV").disabled).toBe(false);
      } finally {
        await act(async () => root.unmount());
        dom.restore();
      }
    },
  );
});

function configurePanelResources(options: {
  artifactRevision?: string;
  branchStatus?: string;
  manifestRunId?: string;
  manifestSessionId?: string;
  manifestStageId?: string;
  modeFieldAvailable?: boolean;
  runId?: string;
  sessionId?: string;
  stageId?: string;
} = {}): void {
  const sessionId = options.sessionId ?? "session-7";
  const runId = options.runId ?? "run-7";
  const stageId = options.stageId ?? "eigen-stage-7";
  panelMocks.manifest = modalManifestResource({
    ...(options.manifestRunId ? { run_id: options.manifestRunId } : {}),
    ...(options.manifestSessionId
      ? { session_id: options.manifestSessionId }
      : {}),
    ...(options.manifestStageId
      ? { stage_id: options.manifestStageId }
      : {}),
  });
  panelMocks.manifestStatus = "ready";
  panelMocks.branchStatus = options.branchStatus ?? "ready";
  panelMocks.branchArtifact = {
    artifact_path: "eigen/branches.v2.json",
    artifact_set_id: "sha256:artifact-set-7",
    content_digest: "sha256:branches-bytes-7",
    mesh_generation_id: "mesh-7",
    payload: {
      branches: [
        {
          branch_id: "acoustic",
          points: [
            {
              frequency_imag_hz: -14e6,
              frequency_real_hz: 13.1e9,
              mode_field_available: options.modeFieldAvailable ?? true,
              ...(options.modeFieldAvailable === false
                ? {}
                : {
                    mode_field_id: "analysis:eigen:sample-0001:mode-0001",
                    mode_field_resource_key:
                      "data/fields/analysis%3Aeigen%3Asample-0001%3Amode-0001?view=phase_rotated_real&phase_rad=0",
                  }),
              mode_id: "mode-0001",
              overlap_prev: 0.97,
              path_s_rad_per_m: 1.25e7,
              raw_mode_index: 1,
              residual_norm: 2e-8,
              sample_id: "sample-0001",
              sample_index: 1,
              tracking_confidence: 0.98,
              wavevector_kf: [1.25e7, 0, 0],
            },
          ],
        },
      ],
    },
    resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    revision: options.artifactRevision ?? "sha256:branches-revision-7",
    run_id: runId,
    schema_version: "frequency_domain_eigen_branches.v2",
    session_id: sessionId,
    stage_id: stageId,
    status: "ready",
  } as unknown as FrequencyDomainJsonArtifactResource;
}

function branchInspectorSelection(identity: {
  datasetId?: string;
  datasetRevision?: string;
} = {}): Parameters<
  typeof EigenBranchInspectorPanel
>[0]["selection"] {
  const nodeId = "results:eigen:branch:acoustic";
  return {
    kind: "results.eigen.branch",
    label: "Acoustic branch",
    moduleSource: "frequency-domain",
    nodeId,
    objectId: null,
    ref: {
      branchId: "acoustic",
      datasetId: identity.datasetId ?? "dataset-canonical",
      datasetRevision: identity.datasetRevision ?? "sha256:dataset-revision",
      kind: "results.eigen.branch",
      nodeId,
      type: "frequency-domain",
    },
  } as Parameters<typeof EigenBranchInspectorPanel>[0]["selection"];
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(
    root,
    (element) =>
      element.tagName === "BUTTON" &&
      (element.getAttribute("aria-label") === text ||
        element.textContent.includes(text)),
  )[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findRoleMessage(
  root: TestNode,
  role: string,
  message: string,
): TestElement | null {
  return findElements(
    root,
    (element) =>
      element.getAttribute("role") === role &&
      element.textContent === message,
  )[0] ?? null;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function deferredPromise<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}
