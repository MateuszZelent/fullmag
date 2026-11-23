import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";
import { createModeFieldOverlayIntent } from "@/kernel/visualization/ModeFieldOverlayIntent";
import type { EigenDispersionPoint, EigenSpectrumPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import {
  buildEigenDispersionPointSelectionRefFromSelection,
  EigenSpectrumInspectorPanel,
} from "../../inspectors/results/frequency-domain";

const mocks = vi.hoisted(() => ({
  chart: vi.fn<(_props: {
    onSelectMode: (target: EigenSpectrumPoint) => void;
    onPlotMode: (target: EigenSpectrumPoint) => void;
  }) => null>(() => null),
  execute: vi.fn(),
  select: vi.fn(),
  spectrum: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/KernelContext")>(),
  useKernel: () => ({
    commands: { execute: mocks.execute },
    selection: { set: mocks.select },
  }),
}));
vi.mock("@/kernel/visualization/AnalysisFieldOverlayController", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/visualization/AnalysisFieldOverlayController")>(),
  useRenderableAnalysisFieldOverlay: () => null,
}));
vi.mock("../FrequencyDomainCharts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../FrequencyDomainCharts")>(),
  FrequencyDomainSpectrumChart: mocks.chart,
}));
vi.mock("./frequencyDomainEigenFmrSummaries", async (importOriginal) => ({
  ...await importOriginal<typeof import("./frequencyDomainEigenFmrSummaries")>(),
  useEigenSpectrumSummary: mocks.spectrum,
}));

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


it("inspects a spectrum point and plots its phase-rotated field from the published stage", () => {
  const point: EigenSpectrumPoint = {
    branchId: null,
    dampingRateHz: null,
    displayModeIndex: 2,
    frequencyHz: 7.5e9,
    imaginaryFrequencyHz: null,
    modeFieldAvailable: true,
    modeFieldId: dispersionPoint.modeFieldId,
    modeFieldResourceKey: dispersionPoint.modeFieldResourceKey,
    modeId: dispersionPoint.modeId,
    rawModeIndex: 2,
    residualNorm: null,
    sampleId: dispersionPoint.sampleId,
    sampleIndex: 0,
    tangentLeakageMax: null,
  };
  const selection: Selection = {
    ...EMPTY_SELECTION,
    kind: "results.resonance.modal.spectrum",
    ref: {
      analysisRunId: "published-run",
      analysisStageId: "modal-stage",
      artifactRevision: "published-revision",
      kind: "results.resonance.modal.spectrum",
      nodeId: "spectrum",
      type: "frequency-domain",
    },
  };
  mocks.spectrum.mockReturnValue({
    badge: "ready",
    spectrumModel: { points: [point] },
    spectrumPublication: {
      generation_id: "spectrum-generation",
      run_id: "published-run",
      stage_id: "modal-stage",
    },
  });

  renderToStaticMarkup(<EigenSpectrumInspectorPanel selection={selection} />);
  const chart = mocks.chart.mock.lastCall?.[0];
  expect(chart).toEqual(expect.objectContaining({
    onSelectMode: expect.any(Function),
    onPlotMode: expect.any(Function),
  }));
  const { onSelectMode, onPlotMode } = chart!;
  onSelectMode(point);
  expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({
    kind: "results.resonance.modal.mode",
    ref: expect.objectContaining({
      analysisRunId: "published-run",
      analysisStageId: "modal-stage",
      artifactRevision: "published-revision",
      fieldId: point.modeFieldId,
    }),
  }), "inspector");

  onPlotMode(point);
  expect(mocks.execute).toHaveBeenCalledWith(
    "analysis.eigen.plot-mode-3d",
    expect.anything(),
    expect.objectContaining({
      artifactGenerationId: "spectrum-generation",
      fieldId: point.modeFieldId,
      view: "phase_rotated_real",
    }),
  );
});
