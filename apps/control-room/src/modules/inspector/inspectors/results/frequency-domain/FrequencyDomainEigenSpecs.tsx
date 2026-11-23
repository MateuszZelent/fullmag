"use client";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import { useKernel } from "@/kernel/KernelContext";
import { ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH } from "@/kernel/api/apiPaths";
import {
  buildEigenBranchSelectionRef,
  buildEigenDispersionPointSelectionRef,
  type EigenBranch,
  type EigenDispersionPoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  FrequencyDomainDispersionChart,
  FrequencyDomainSpectrumChart,
} from "../../../panels/FrequencyDomainCharts";
import { EigenModeBrowser, FrequencyDomainBranchTable } from "../../../panels/FrequencyDomainTables";
import {
  useFrequencyDomainDispersionSummary,
  useEigenDiagnosticsSummary,
  useEigenBranchesSummary,
  useEigenSpectrumSummary,
  useFrequencyDomainResponseMapSummary,
  useEigenModesSummary,
} from "../../../panels/frequency-domain/frequencyDomainEigenFmrSummaries";
import { useEigenModeBrowser, ModalSpectrumStatus } from "./frequencyDomainShared";

export function FrequencyDomainDispersionInspectorPanel(
  props: InspectorPanelProps,
) {
  const summary = useFrequencyDomainDispersionSummary();
  const kernel = useKernel();
  const selectPoint = (point: EigenDispersionPoint): void => {
    const ref = buildEigenDispersionPointSelectionRefFromSelection(point, props.selection);
    kernel.selection.set(
      {
        kind: ref.kind,
        label: `Sample ${point.sampleIndex} · Mode ${point.rawModeIndex}`,
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "inspector",
    );
  };
  const selectBranch = (branch: EigenBranch): void => {
    const ref = buildEigenBranchSelectionRef(branch);
    kernel.selection.set(
      {
        kind: "results.eigen.branch",
        label: branch.label ?? `Branch ${branch.branchId}`,
        nodeId: ref.nodeId ?? `results:eigen:branches:branch:${branch.branchId}`,
        objectId: null,
        ref,
      },
      "inspector",
    );
  };

  return (
    <div data-inspector-surface="frequency-domain-dispersion">
      <InspectorGroup
        title="Frequency-Domain Dispersion Workbench"
        badge={summary.badge}
      >
        <FieldRow
          label="Canonical workflow"
          value="dispersion_modal -> StudyIR::Eigenmodes"
        />
        <FieldRow
          label="Dispersion resource"
          value={summary.dispersionResource}
        />
        <FieldRow
          label="Path metadata artifact"
          value={summary.pathMetadataArtifact}
        />
        <FieldRow label="Path sampling" value={summary.pathSampling} />
        <FieldRow label="Path labels" value={summary.pathLabels} />
        <FieldRow
          label="Dispersion points"
          value={`${summary.dispersionPointCount} point(s), ${summary.dispersionSeriesCount} series`}
        />
        <FieldRow
          label="Analytic reference"
          value={summary.analyticReference}
        />
        <FieldRow
          label="Validation intent"
          value={summary.validationIntent}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="k-path span" value={summary.kPathSpan} />
        <FieldRow
          label="Branch tracking"
          value={`${summary.branchCount} branch(es), ${summary.trackedPointCount} tracked point(s)`}
        />
        <FieldRow label="Primary branch" value={summary.primaryBranch} />
        <FieldRow label="Modal fields" value={summary.modalOverlays} />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
      </InspectorGroup>
      <InspectorGroup title="Dispersion Chart" badge={summary.badge}>
        <FrequencyDomainDispersionChart
          model={summary.dispersionModel}
          onSelectPoint={selectPoint}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Dispersion Branch Table"
        badge={`${summary.branchCount} branch(es)`}
      >
        <FrequencyDomainBranchTable
          branches={summary.branchesModel.branches}
          onSelectBranch={selectBranch}
        />
      </InspectorGroup>
    </div>
  );
}

export function buildEigenDispersionPointSelectionRefFromSelection(
  point: EigenDispersionPoint,
  selection: InspectorPanelProps["selection"],
): ReturnType<typeof buildEigenDispersionPointSelectionRef> {
  const ownerRef = selection.ref?.type === "frequency-domain"
    ? selection.ref
    : null;
  return buildEigenDispersionPointSelectionRef(point, {
    analysisRunId: ownerRef?.analysisRunId,
    analysisStageId: ownerRef?.analysisStageId,
    artifactRevision: ownerRef?.artifactRevision,
    datasetId: ownerRef?.datasetId,
    datasetRevision: ownerRef?.datasetRevision,
    artifactPath: ownerRef?.artifactPath,
    calculationMode: "dispersion_modal",
    equilibriumId: ownerRef?.equilibriumId,
    kContextKind: ownerRef?.kContextKind,
    normalization: ownerRef?.normalization,
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    source: ownerRef?.source,
    studyProduct: ownerRef?.studyProduct,
    wavevectorKf: ownerRef?.wavevectorKf,
  });
}

export function EigenKPathInspectorPanel(props: InspectorPanelProps) {
  const summary = useFrequencyDomainDispersionSummary();
  const kernel = useKernel();
  const selectPoint = (point: EigenDispersionPoint): void => {
    const ref = buildEigenDispersionPointSelectionRefFromSelection(point, props.selection);
    kernel.selection.set(
      {
        kind: ref.kind,
        label: `Sample ${point.sampleIndex} · Mode ${point.rawModeIndex}`,
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "inspector",
    );
  };

  return (
    <div data-inspector-surface="eigen-k-path">
      <InspectorGroup title="Eigen k-Path Inspector" badge={summary.badge}>
        <FieldRow
          label="Canonical workflow"
          value="dispersion_modal -> StudyIR::Eigenmodes"
        />
        <FieldRow
          label="Dispersion resource"
          value={summary.dispersionResource}
        />
        <FieldRow
          label="Path metadata artifact"
          value={summary.pathMetadataArtifact}
        />
        <FieldRow label="Path sampling" value={summary.pathSampling} />
        <FieldRow label="Path labels" value={summary.pathLabels} />
        <FieldRow label="k-path span" value={summary.kPathSpan} />
        <FieldRow
          label="Frequency coverage"
          value={summary.frequencyRange}
        />
        <FieldRow
          label="Analytic reference"
          value={summary.analyticReference}
        />
        <FieldRow
          label="Validation intent"
          value={summary.validationIntent}
        />
        <FieldRow
          label="Sample count"
          value={`${summary.dispersionPointCount} point(s)`}
        />
        <FieldRow
          label="Branch tracking"
          value={`${summary.branchCount} branch(es), ${summary.trackedPointCount} tracked point(s)`}
        />
        <FieldRow label="Primary branch" value={summary.primaryBranch} />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
        <FieldRow
          label="3D workflow"
          value="select dispersion point -> inspect branch/mode -> plot mode field"
        />
      </InspectorGroup>
      <InspectorGroup title="Dispersion Chart" badge={summary.badge}>
        <FrequencyDomainDispersionChart
          model={summary.dispersionModel}
          onSelectPoint={selectPoint}
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenBranchesInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenBranchesSummary();

  return (
    <div data-inspector-surface="eigen-branches-table">
      <InspectorGroup title="Eigen Branch Table" badge={summary.badge}>
        <FieldRow
          label="Canonical object"
          value="tracked modal branches from StudyIR::Eigenmodes dispersion"
        />
        <FieldRow label="Branch resource" value={summary.branchResource} />
        <FieldRow label="Branch count" value={summary.branchCount} />
        <FieldRow label="Primary branch" value={summary.primaryBranch} />
        <FieldRow label="Frequency coverage" value={summary.frequencyCoverage} />
        <FieldRow label="Sample coverage" value={summary.sampleCoverage} />
        <FieldRow label="Overlap quality" value={summary.overlapQuality} />
        <FieldRow label="Branch gaps" value={summary.branchGaps} />
        <FieldRow label="Branch warnings" value={summary.branchWarnings} />
        <FieldRow label="Representative mode" value={summary.representativeMode} />
        <FieldRow
          label="Dispersion workflow"
          value="select branch -> inspect tracked modes -> plot mode field"
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainResponseMapInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainResponseMapSummary();

  return (
    <div data-inspector-surface="frequency-domain-response-map">
      <InspectorGroup title="Response Map Control" badge={summary.badge}>
        <FieldRow
          label="Canonical workflow"
          value="nonzero-k FrequencyResponse response map"
        />
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Capability gate" value={summary.capabilityGate} />
        <FieldRow
          label="Response-map availability"
          value={summary.availability}
        />
        <FieldRow label="Floquet request" value={summary.floquetRequest} />
        <FieldRow label="Blocking physics" value={summary.blockingPhysics} />
        <FieldRow
          label="Current response evidence"
          value={summary.currentResponseEvidence}
        />
        <FieldRow label="UI fallback" value={summary.uiFallback} />
      </InspectorGroup>
    </div>
  );
}

export function EigenSpectrumInspectorPanel({ selection }: InspectorPanelProps) {
  const summary = useEigenSpectrumSummary();
  const browser = useEigenModeBrowser(selection, summary.spectrumPublication);
  if (!browser.hasSpectrum) return <ModalSpectrumStatus loading={summary.badge === "loading"} />;

  return (
    <div data-inspector-surface="eigen-spectrum">
      <InspectorGroup title="Eigenfrequency Spectrum" summary={summary.frequencyRange}>
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={(point) => browser.onView(point, "phase_rotated_real")}
          onSelectMode={browser.onInspect}
        />
      </InspectorGroup>
      <InspectorGroup title="Modes" summary={`${summary.fieldOverlayCount} profiles · ${summary.modeCount} frequencies`}>
        <EigenModeBrowser {...browser} points={summary.spectrumModel.points} />
      </InspectorGroup>
      <InspectorGroup collapsible defaultOpen={false} title="Spectrum details">
        <FieldRow label="Solve status" value={summary.solveStatus} />
        <FieldRow label="Spectrum completeness" value={summary.spectrumCompleteness} />
        <FieldRow label="Window certificate" value={summary.windowCertificate} />
        <FieldRow label="Damping coverage" value={summary.dampingCoverage} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Candidate identity" value={summary.candidateIdentity} />
        <FieldRow label="Spectrum resource" value={summary.spectrumResource} />
      </InspectorGroup>
    </div>
  );
}

export function EigenModesInspectorPanel({ selection }: InspectorPanelProps) {
  const summary = useEigenSpectrumSummary();
  const browser = useEigenModeBrowser(selection, summary.spectrumPublication);
  if (!browser.hasSpectrum) return <ModalSpectrumStatus loading={summary.badge === "loading"} />;

  return (
    <div data-inspector-surface="eigen-modes-browser">
      <InspectorGroup title="Mode Shapes" summary={`${summary.fieldOverlayCount} profiles · ${summary.modeCount} frequencies`}>
        <EigenModeBrowser {...browser} points={summary.spectrumModel.points} />
      </InspectorGroup>
    </div>
  );
}

export function EigenModesVisualizationInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useEigenModesSummary();

  return (
    <div data-inspector-surface="eigen-modes-visualization">
      <InspectorGroup title="Eigen Modes Visualization" badge={summary.badge}>
        <FieldRow
          label="Shared style scope"
          value="one visualization preset for the modes collection"
        />
        <FieldRow label="Mode table resource" value={summary.modeTableResource} />
        <FieldRow label="Mode table" value={summary.modeTable} />
        <FieldRow
          label="Selectable fields"
          value={summary.firstSelectableMode}
        />
        <FieldRow
          label="Mode switch behavior"
          value="change active field, keep shader/vector/color controls"
        />
        <FieldRow
          label="3D controls"
          value="field view, color source, colormap, solid color, vector budget, scope"
        />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenDiagnosticsInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenDiagnosticsSummary();

  return (
    <div data-inspector-surface="eigen-diagnostics">
      <InspectorGroup title="Eigen Diagnostics" badge={summary.badge}>
        <FieldRow
          label="Modal availability"
          value={summary.modalAvailability}
        />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
        <FieldRow label="Modal spectrum" value={summary.modalSpectrum} />
        <FieldRow
          label="Branch diagnostics"
          value={summary.branchDiagnostics}
        />
        <FieldRow label="Solver model" value={summary.solverModel} />
        <FieldRow label="Floquet transport" value={summary.floquetTransport} />
        <FieldRow label="Dispersion samples" value={summary.dispersionSamples} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Demag-k gate" value={summary.demagKGate} />
      </InspectorGroup>
    </div>
  );
}
