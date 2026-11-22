"use client";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
} from "@/kernel/api/apiPaths";
import { useFrequencyDomainManifestResource } from "@/kernel/resources/studyRuntimeResources";
import { frequencyDomainManifestPayload } from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  useFrequencyDomainOverviewSummary,
  useEigenOverviewSummary,
  useEigenStudySummary,
  useFrequencyResponseOverviewSummary,
  useFrequencyResponseStudySummary,
  useFrequencyDomainRunSummary,
  useFrequencyDomainProvenanceSummary,
  useFrequencyDomainExportsSummary,
  useCalculationModesSummary,
} from "../../../panels/frequency-domain/frequencyDomainEigenFmrSummaries";
import { record, isDrivenExcitationMissing } from "../../../panels/frequency-domain/frequencyDomainResultFormatting";
import {
  CalculationModeTable,
  CalculationModeActions,
  ResultShortcutActions,
  type ProvenancePanelProps,
} from "./frequencyDomainShared";

export function FrequencyDomainCalculationModesInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useCalculationModesSummary();

  return (
    <div data-inspector-surface="frequency-domain-calculation-modes">
      <InspectorGroup
        title="Frequency-Domain Workflow Router"
        badge={summary.activeMode}
      >
        <FieldRow label="Active workflow" value={summary.activeWorkflow} />
        <FieldRow label="Canonical study" value={summary.activeStudy} />
        <FieldRow label="Primary result chart" value={summary.primaryChart} />
        <FieldRow
          label="Supported modal workflows"
          value={summary.modalWorkflows}
        />
        <FieldRow
          label="Supported driven workflows"
          value={summary.drivenWorkflows}
        />
        <FieldRow label="Modal evidence" value={summary.modalEvidence} />
        <FieldRow label="Driven evidence" value={summary.drivenEvidence} />
        <FieldRow label="Response-map gate" value={summary.responseMapGate} />
        <FieldRow label="Required artifacts" value={summary.requiredArtifacts} />
        <FieldRow label="Capability route" value={summary.capabilityRoute} />
      </InspectorGroup>
      <InspectorGroup
        title="Calculation Mode Matrix"
        badge={`${summary.modeRows.length} mode(s)`}
      >
        <CalculationModeTable
          activeMode={summary.activeMode}
          rows={summary.modeRows}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Calculation Mode Result Shortcuts"
        badge={summary.activeMode}
      >
        <CalculationModeActions />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainRunInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFrequencyDomainRunSummary();

  return (
    <div data-inspector-surface="frequency-domain-run-provenance">
      <InspectorGroup
        title="Frequency-Domain Run Provenance"
        badge={summary.badge}
      >
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Manifest artifact" value={summary.manifestArtifact} />
        <FieldRow label="Calculation mode" value={summary.calculationMode} />
        <FieldRow label="Stage kind" value={summary.stageKind} />
        <FieldRow label="Family namespace" value={summary.familyNamespace} />
        <FieldRow label="Eigen namespace" value={summary.eigenNamespace} />
        <FieldRow label="Response lane" value={summary.responseLane} />
        <FieldRow label="Eigen lane" value={summary.eigenLane} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
        <FieldRow
          label="Namespace compatibility"
          value={summary.namespaceCompatibility}
        />
      </InspectorGroup>
      <InspectorGroup title="Run Resource Links" badge={summary.calculationMode}>
        <ResultShortcutActions
          actions={[
            {
              kind: "results.frequency_domain.calculation_modes",
              label: "Calculation Modes",
              nodeId: "results:frequency-domain:calculation-modes",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
              title: "Open calculation modes",
            },
            {
              kind: "results.frequency_domain.fmr",
              label: "FMR",
              nodeId: "results:frequency-domain:fmr",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
              title: "Open FMR workbench",
            },
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainOverviewInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainOverviewSummary();

  return (
    <div data-inspector-surface="frequency-domain-overview">
      <InspectorGroup
        title="Frequency-Domain Results Overview"
        badge={summary.badge}
      >
        <FieldRow label="Primary workflow" value={summary.primaryWorkflow} />
        <FieldRow label="FMR readiness" value={summary.fmrReadiness} />
        <FieldRow
          label="Modal visualization"
          value={summary.modalVisualization}
        />
        <FieldRow
          label="Driven visualization"
          value={summary.drivenVisualization}
        />
        <FieldRow label="Frequency coverage" value={summary.frequencyCoverage} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
        <FieldRow label="Resources" value={summary.resources} />
        <FieldRow label="Next action" value={summary.nextAction} />
      </InspectorGroup>
      <InspectorGroup title="Result Family Shortcuts" badge={summary.badge}>
        <ResultShortcutActions
          actions={[
            {
              kind: "results.frequency_domain.fmr",
              label: "FMR",
              nodeId: "results:frequency-domain:fmr",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
              title: "Open FMR workbench",
            },
            {
              kind: "results.eigen.root",
              label: "Eigen",
              nodeId: "results:eigen",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              title: "Open eigen results",
            },
            {
              kind: "results.frequency_response.root",
              label: "Frequency Response",
              nodeId: "results:frequency-response",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              title: "Open response results",
            },
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenProvenanceInspectorPanel({
  canonicalFamily = "Eigenmodes modal lane",
  linksBadge = "modal",
  linksTitle = "Eigen Provenance Links",
  title = "Eigen Provenance",
}: ProvenancePanelProps) {
  const summary = useFrequencyDomainProvenanceSummary();

  return (
    <div data-inspector-surface="eigen-provenance">
      <InspectorGroup title={title} badge={summary.calculationMode}>
        <FieldRow label="Canonical family" value={canonicalFamily} />
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Manifest artifact" value={summary.manifestArtifact} />
        <FieldRow
          label="Requested calculation"
          value={summary.calculationMode}
        />
        <FieldRow label="Stage kind" value={summary.stageKind} />
        <FieldRow label="Modal availability" value={summary.eigenLane} />
        <FieldRow
          label="Modal spectrum artifact"
          value={summary.modalSpectrumArtifact}
        />
        <FieldRow label="Branch artifact" value={summary.branchArtifact} />
        <FieldRow label="Mode field artifacts" value={summary.modeFieldArtifacts} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
      </InspectorGroup>
      <InspectorGroup title={linksTitle} badge={linksBadge}>
        <ResultShortcutActions
          actions={[
            {
              kind: "results.eigen.spectrum",
              label: "Eigen Spectrum",
              nodeId: "results:eigen:spectrum",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              title: "Open modal spectrum",
            },
            {
              kind: "results.eigen.modes",
              label: "Eigen Modes",
              nodeId: "results:eigen:modes",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              title: "Open mode browser",
            },
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenOverviewInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenOverviewSummary();

  return (
    <div data-inspector-surface="eigen-overview">
      <InspectorGroup title="Eigen Results Overview" badge={summary.badge}>
        <FieldRow label="Spectrum" value={summary.spectrum} />
        <FieldRow label="Frequency coverage" value={summary.frequencyCoverage} />
        <FieldRow label="Dispersion" value={summary.dispersion} />
        <FieldRow label="Branches" value={summary.branches} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
        <FieldRow label="3D handoff" value={summary.handoff} />
      </InspectorGroup>
      <InspectorGroup title="Eigen Result Shortcuts" badge={summary.badge}>
        <ResultShortcutActions
          actions={[
            {
              kind: "results.eigen.spectrum",
              label: "Eigen Spectrum",
              nodeId: "results:eigen:spectrum",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              title: "Open spectrum",
            },
            {
              kind: "results.eigen.modes",
              label: "Eigen Modes",
              nodeId: "results:eigen:modes",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              title: "Open mode browser",
            },
            {
              kind: "results.eigen.dispersion",
              label: "Eigen Dispersion",
              nodeId: "results:eigen:dispersion",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
              title: "Open dispersion",
            },
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenStudyInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenStudySummary();

  return (
    <div data-inspector-surface="eigen-study">
      <InspectorGroup
        title="Eigenmodes Study Contract"
        badge={summary.badge}
      >
        <FieldRow label="Study kind" value={summary.studyKind} />
        <FieldRow label="Operator lane" value={summary.operatorLane} />
        <FieldRow label="Boundary support" value={summary.boundarySupport} />
        <FieldRow label="Artifacts" value={summary.artifacts} />
        <FieldRow label="Mode fields" value={summary.modeFields} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
      </InspectorGroup>
      <InspectorGroup title="Eigen Study Readback" badge="ProblemIR">
        <FieldRow
          label="Authoring source"
          value="StudyIR::Eigenmodes stage; inspector is a result readback surface"
        />
        <FieldRow
          label="Round-trip action"
          value="edit the source stage in Study; this result panel preserves provenance"
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseProvenanceInspectorPanel(
  {
    canonicalFamily = "FrequencyResponse driven lane",
    linksBadge = "driven",
    linksTitle = "Response Provenance Links",
    title = "Frequency Response Provenance",
  }: ProvenancePanelProps,
) {
  const summary = useFrequencyDomainProvenanceSummary();

  return (
    <div data-inspector-surface="frequency-response-provenance">
      <InspectorGroup title={title} badge={summary.calculationMode}>
        <FieldRow label="Canonical family" value={canonicalFamily} />
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Manifest artifact" value={summary.manifestArtifact} />
        <FieldRow
          label="Requested calculation"
          value={summary.calculationMode}
        />
        <FieldRow label="Stage kind" value={summary.stageKind} />
        <FieldRow label="Driven availability" value={summary.responseLane} />
        <FieldRow label="Requested spin-wave BC" value={summary.spinWaveBc} />
        <FieldRow
          label="Requested magnetostatic BC"
          value={summary.magnetostaticBc}
        />
        <FieldRow
          label="Response sweep artifact"
          value={summary.responseSweepArtifact}
        />
        <FieldRow
          label="Response field artifacts"
          value={summary.responseFieldArtifacts}
        />
        <FieldRow label="Cancel artifact" value={summary.cancelArtifact} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
      </InspectorGroup>
      <InspectorGroup title={linksTitle} badge={linksBadge}>
        <ResultShortcutActions
          actions={[
            {
              kind: "results.frequency_response.sweep",
              label: "Response Sweep",
              nodeId: "results:frequency-response:sweep",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              title: "Open response sweep",
            },
            {
              kind: "results.frequency_response.frequency_points",
              label: "Response Points",
              nodeId: "results:frequency-response:frequency-points",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              title: "Open frequency points",
            },
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseOverviewInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const missingExcitation = isDrivenExcitationMissing(manifestPayload);

  const summary = useFrequencyResponseOverviewSummary();

  if (missingExcitation) {
    return (
      <div data-inspector-surface="frequency-response-overview">
        <InspectorGroup title="Driven Response Validation" badge="blocking">
          <div className="fm-inspector-alert fm-alert-danger">
            <div className="fm-fd-alert__title">Drive source: missing</div>
            <div className="fm-fd-alert__row"><strong>Severity:</strong> blocking</div>
            <div className="fm-fd-alert__row"><strong>Message:</strong> Frequency-domain response requires a dynamic perturbation δh. Without excitation, the response is identically zero.</div>
            <div className="fm-fd-alert__row"><strong>Action:</strong> Add drive source</div>
          </div>
        </InspectorGroup>
      </div>
    );
  }

  return (
    <div data-inspector-surface="frequency-response-overview">
      <InspectorGroup
        title="Frequency Response Results Overview"
        badge={summary.badge}
      >
        <FieldRow label="Sweep" value={summary.sweep} />
        <FieldRow label="Frequency coverage" value={summary.frequencyCoverage} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Cancellation" value={summary.cancellation} />
        <FieldRow label="Response fields" value={summary.responseFields} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
        <FieldRow label="3D handoff" value={summary.handoff} />
      </InspectorGroup>
      <InspectorGroup title="Response Result Shortcuts" badge={summary.badge}>
        <ResultShortcutActions
          actions={[
            {
              kind: "results.frequency_response.sweep",
              label: "Response Sweep",
              nodeId: "results:frequency-response:sweep",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              title: "Open sweep",
            },
            {
              kind: "results.frequency_response.frequency_points",
              label: "Response Points",
              nodeId: "results:frequency-response:frequency-points",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              title: "Open frequency points",
            },
            {
              kind: "results.frequency_response.observables",
              label: "Response Observables",
              nodeId: "results:frequency-response:observables",
              resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              title: "Open observables",
            },
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseStudyInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseStudySummary();

  return (
    <div data-inspector-surface="frequency-response-study">
      <InspectorGroup
        title="Frequency Response Study Contract"
        badge={summary.badge}
      >
        <FieldRow label="Study kind" value={summary.studyKind} />
        <FieldRow label="Execution lane" value={summary.executionLane} />
        <FieldRow label="Requested spin-wave BC" value={summary.spinWaveBc} />
        <FieldRow
          label="Requested magnetostatic BC"
          value={summary.magnetostaticBc}
        />
        <FieldRow label="Boundary support" value={summary.boundarySupport} />
        <FieldRow label="Sweep contract" value={summary.sweepContract} />
        <FieldRow label="Artifacts" value={summary.artifacts} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
      </InspectorGroup>
      <InspectorGroup title="Response Study Readback" badge="ProblemIR">
        <FieldRow
          label="Authoring source"
          value="StudyIR::FrequencyResponse stage; inspector is a result readback surface"
        />
        <FieldRow
          label="Round-trip action"
          value="edit excitation, sweep, solver, and outputs in the source Study stage"
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainExportsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainExportsSummary();

  return (
    <div data-inspector-surface="frequency-domain-exports">
      <InspectorGroup
        title="Frequency-Domain Exports"
        badge={summary.badge}
      >
        <FieldRow label="Reproducibility bundle" value={summary.bundle} />
        <FieldRow label="Manifest" value={summary.manifest} />
        <FieldRow label="Modal spectrum" value={summary.modalSpectrum} />
        <FieldRow label="Modal branches" value={summary.modalBranches} />
        <FieldRow label="Modal dispersion" value={summary.modalDispersion} />
        <FieldRow label="Driven sweep" value={summary.drivenSweep} />
        <FieldRow label="Field payloads" value={summary.fieldPayloads} />
        <FieldRow label="Export formats" value={summary.exportFormats} />
        <FieldRow label="Python round-trip" value={summary.pythonRoundTrip} />
        <FieldRow label="API resources" value={summary.apiResources} />
      </InspectorGroup>
    </div>
  );
}
