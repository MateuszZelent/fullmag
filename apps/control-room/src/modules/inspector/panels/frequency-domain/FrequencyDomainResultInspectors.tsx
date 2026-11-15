"use client";

/**
 * Dedicated frequency-domain result / resource / job / diagnostic inspector
 * panel components. Each non-authoring frequency-domain node kind receives its
 * own component reference so the registry cannot silently route a new kind to a
 * generic fallback.
 */

import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FmrPeakInspector } from "./FmrPeakInspector";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StudyProgressBar } from "../StudyProgressBar";
import { Activity, Eye } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
} from "@/kernel/api/apiPaths";
import { useFrequencyDomainManifestResource } from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchSelectionRef,
  buildEigenDispersionPointSelectionRef,
  buildFrequencyResponsePointSelectionRef,
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  EigenBranch,
  EigenDispersionPoint,
  EigenSpectrumPoint,
  FmrModalDrivenComparisonPoint,
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  FrequencyDomainDispersionChart,
  FrequencyDomainResponseChart,
  FrequencyDomainSpectrumChart,
} from "../FrequencyDomainCharts";
import {
  FrequencyDomainBranchTable,
  FrequencyDomainFmrPeakTable,
  FrequencyDomainModeTable,
  type FrequencyDomainModeTableAction,
} from "../FrequencyDomainTables";
import { type FrequencyDomainCalculationModeRow } from "../frequencyDomainInspectorModel";
import { EigenModeInspectorPanel } from "./EigenModeInspectorPanel";
export { FmrModalSpectrumInspectorPanel } from "./FmrModalSpectrumInspectorPanel";
export { EigenBranchInspectorPanel } from "./EigenBranchInspectorPanel";
export { EigenDispersionInspectorPanel } from "./EigenDispersionInspectorPanel";
export { EigenModeInspectorPanel } from "./EigenModeInspectorPanel";
import {
  buildFrequencyResponsePlotCommandInput,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
} from "./FrequencyResponseInspectorPanels";
import {
  useFmrResultSummary,
  useFrequencyDomainOverviewSummary,
  useEigenOverviewSummary,
  useEigenStudySummary,
  useFrequencyResponseOverviewSummary,
  useFrequencyResponseStudySummary,
  useFrequencyDomainRunSummary,
  useFmrComparisonSummary,
  useFrequencyDomainProvenanceSummary,
  useFrequencyDomainDispersionSummary,
  useEigenDiagnosticsSummary,
  useEigenBranchesSummary,
  useEigenSpectrumSummary,
  useFrequencyDomainResponseMapSummary,
  useEigenModesSummary,
  useFrequencyDomainExportsSummary,
  useCalculationModesSummary,
  useFmrPeakSummary,
} from "./frequencyDomainEigenFmrSummaries";
import {
  useFrequencyResponseFrequencyPointsSummary,
  useFrequencyResponseProgressSummary,
  useFrequencyResponseSweepSummary,
  useEigenSampleJobSummary,
} from "./frequencyDomainResponseSummaries";
import {
  record,
  isDrivenExcitationMissing,
  formatNumberOrUnavailable,
  formatFmrModalPairLabel,
  formatFmrDrivenPairLabel,
  formatFmrPairFieldHandoff,
  formatFmrPairAmplitudeRatio,
  formatFmrPeakSourceLabel,
  formatFmrPeakTarget,
  formatFmrPeakQualityFactor,
  formatPowerDensity,
  formatFrequency,
} from "./frequencyDomainResultFormatting";
export {
  frequencyDomainVisualizationReadiness,
  isDrivenExcitationMissing,
} from "./frequencyDomainResultFormatting";
export {
  type FrequencyResponsePointResidualSummary,
  countResidualEvidencePoints,
  buildFrequencyResponsePointResidualSummary,
  FrequencyResponsePointResidualFields,
} from "./frequencyDomainResponseSummaries";
export {
  responseMapAvailabilityFromTypedResource,
} from "./frequencyDomainEigenFmrSummaries";
export {
  FrequencyDomainJobsOverviewInspectorPanel,
  FrequencyDomainStageRunJobInspectorPanel,
  EigenSampleJobInspectorPanel,
  FrequencyResponseFrequencyJobInspectorPanel,
  FrequencyResponseProgressJobInspectorPanel,
  FrequencyDomainArtifactExportJobInspectorPanel,
  FrequencyDomainDiagnosticsOverviewInspectorPanel,
  FrequencyDomainCapabilitiesDiagnosticInspectorPanel,
  FrequencyDomainEquilibriumDiagnosticInspectorPanel,
  FrequencyDomainOperatorDiagnosticInspectorPanel,
  FrequencyDomainSolverDiagnosticInspectorPanel,
  FrequencyDomainArtifactsDiagnosticInspectorPanel,
  FrequencyDomainApiResourcesDiagnosticInspectorPanel,
  FrequencyDomainVisualizationDiagnosticInspectorPanel,
  FrequencyDomainPeriodicPairsResourceInspectorPanel,
  FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel,
  FrequencyDomainResourceFamilyInspectorPanel,
  FrequencyDomainManifestResourceInspectorPanel,
} from "./FrequencyDomainResourceInspectorPanels";
export {
  buildFrequencyResponsePlotCommandInput,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseFieldsInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
} from "./FrequencyResponseInspectorPanels";

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

function CalculationModeTable({
  activeMode,
  rows,
}: {
  activeMode: string;
  rows: readonly FrequencyDomainCalculationModeRow[];
}) {
  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain calculation mode table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Mode</th>
            <th>Canonical study</th>
            <th>Boundary / k</th>
            <th>Excitation / sweep</th>
            <th>Artifacts</th>
            <th>Capability</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.mode}>
              <td>
                {row.mode}
                {row.mode === activeMode ? " (active)" : ""}
              </td>
              <td>{row.canonicalStudy}</td>
              <td>
                {row.boundaryPreset}; {row.kRequirement}
              </td>
              <td>
                {row.excitationRequirement}; {row.sweepRequirement}
              </td>
              <td>{row.artifacts}</td>
              <td>{row.capabilityStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalculationModeActions() {
  const kernel = useKernel();
  const openResult = (
    kind: string,
    label: string,
    nodeId: string,
    resourceRef: string,
  ): void => {
    kernel.selection.set(
      {
        kind,
        label,
        nodeId,
        objectId: null,
        ref: {
          kind,
          nodeId,
          resourceRef,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open FMR workbench"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.fmr",
            "FMR",
            "results:frequency-domain:fmr",
            ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
          )
        }
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open FMR workbench</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open modal spectrum"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.fmr_modal_spectrum",
            "FMR Modal Spectrum",
            "results:frequency-domain:fmr:modal-spectrum",
            ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
          )
        }
      >
        <Activity size={13} aria-hidden="true" />
        <span>Open modal spectrum</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open response sweep"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.fmr_response_sweep",
            "FMR Response Sweep",
            "results:frequency-domain:fmr:response-sweep",
            ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          )
        }
      >
        <Activity size={13} aria-hidden="true" />
        <span>Open response sweep</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open dispersion"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.dispersion",
            "Dispersion",
            "results:frequency-domain:dispersion",
            ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
          )
        }
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open dispersion</span>
      </Button>
    </div>
  );
}

interface ResultShortcutAction {
  kind: string;
  label: string;
  nodeId: string;
  resourceRef: string;
  title: string;
}

function ResultShortcutActions({
  actions,
}: {
  actions: readonly ResultShortcutAction[];
}) {
  const kernel = useKernel();
  const openResult = (action: ResultShortcutAction): void => {
    kernel.selection.set(
      {
        kind: action.kind,
        label: action.label,
        nodeId: action.nodeId,
        objectId: null,
        ref: {
          kind: action.kind,
          nodeId: action.nodeId,
          resourceRef: action.resourceRef,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      {actions.map((action) => (
        <Button
          key={action.nodeId}
          className="fm-inspector-action-button"
          size="sm"
          title={action.title}
          type="button"
          variant="secondary"
          onClick={() => openResult(action)}
        >
          <Eye size={13} aria-hidden="true" />
          <span>{action.title}</span>
        </Button>
      ))}
    </div>
  );
}

function FmrComparisonPairTable({
  pairs,
}: {
  pairs: readonly FmrModalDrivenComparisonPoint[];
}) {
  if (pairs.length === 0) {
    return (
      <EmptyState className="fm-frequency-domain-table-empty" role="status" size="compact" heading="No modal-driven FMR pairs available." />
    );
  }

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain FMR comparison table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Modal</th>
            <th>Driven</th>
            <th>Detuning</th>
            <th>Validation</th>
            <th>Field handoff</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) => (
            <tr
              key={`${pair.modalPeak.frequencyHz}:${pair.modalPeak.modeRef?.sampleIndex ?? "sample"}:${pair.modalPeak.modeRef?.rawModeIndex ?? "mode"}:${pair.drivenPeak.frequencyHz}:${pair.drivenPeak.frequencyPointIndex ?? "point"}`}
            >
              <td>{formatFmrModalPairLabel(pair)}</td>
              <td>{formatFmrDrivenPairLabel(pair)}</td>
              <td>{formatFrequency(pair.detuningHz)}</td>
              <td>
                {pair.modalPeak.validationStatus} modal,{" "}
                {pair.drivenPeak.validationStatus} driven
              </td>
              <td>{formatFmrPairFieldHandoff(pair)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

interface ProvenancePanelCopy {
  canonicalFamily?: string;
  linksBadge?: string;
  linksTitle?: string;
  title?: string;
}

type ProvenancePanelProps = InspectorPanelProps & ProvenancePanelCopy;

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

export function FmrOverviewInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFmrResultSummary();
  const kernel = useKernel();
  const selectMode = (point: EigenSpectrumPoint): void => {
    const nodeId = `results:eigen:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`;
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${point.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: eigenModeFieldAvailable(point)
            ? point.modeFieldId ?? undefined
            : undefined,
          kind: "results.eigen.mode",
          modeId: point.modeId ?? undefined,
          modeIndex: point.rawModeIndex,
          nodeId,
          resourceRef: eigenModeFieldAvailable(point)
            ? point.modeFieldResourceKey ?? summary.spectrumResource
            : summary.spectrumResource,
          sampleIndex: point.sampleIndex,
          sampleId: point.sampleId ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotMode = (point: EigenSpectrumPoint): void => {
    if (!eigenModeFieldAvailable(point) || !point.modeFieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr",
      }),
      {
        fieldId: point.modeFieldId,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const selectResponsePoint = (point: FrequencyResponsePoint): void => {
    const responseRef = buildFrequencyResponsePointSelectionRef(point, {
      calculationMode: summary.workflowMode,
    });
    kernel.selection.set(
      {
        kind: responseRef.kind,
        label: `${point.observableId} ${formatFrequency(point.frequencyHz)}`,
        nodeId: responseRef.nodeId,
        objectId: null,
        ref: responseRef,
      },
      "inspector",
    );
  };
  const plotResponsePoint = (point: FrequencyResponsePoint): void => {
    if (!point.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr",
      }),
      buildFrequencyResponsePlotCommandInput({
        fieldId: point.fieldId,
        frequencyIndex: point.frequencyIndex,
        label: `${point.observableId} ${formatFrequency(point.frequencyHz)}`,
        phaseRad: point.phaseRad ?? 0,
        view: "phase_rotated_real",
      }),
    );
  };
  const selectPeak = (peak: FmrPeakPoint): void => {
    const peakIndex = summary.peaks.indexOf(peak);
    const nodeId = `results:frequency-domain:fmr:peaks:peak:${peakIndex >= 0 ? peakIndex : 0}`;
    kernel.selection.set(
      {
        kind: "results.frequency_domain.fmr_peak",
        label: `${peak.source} peak ${formatFrequency(peak.frequencyHz)}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: peak.fieldId ?? undefined,
          fmrPeakIndex: peakIndex >= 0 ? peakIndex : undefined,
          kind: "results.frequency_domain.fmr_peak",
          nodeId,
          resourceRef: peak.fieldResourceKey ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotPeak = (peak: FmrPeakPoint): void => {
    if (!peak.fieldId) return;
    void kernel.commands.execute(
      peak.source === "modal"
        ? "analysis.eigen.plot-mode-3d"
        : "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr",
      }),
      {
        fieldId: peak.fieldId,
        frequencyIndex: peak.frequencyPointIndex,
        label: `${peak.source} peak ${formatFrequency(peak.frequencyHz)}`,
        phaseRad: 0,
        source: peak.source === "modal" ? "eigen-mode" : "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-overview">
      <InspectorGroup title="FMR Workbench" badge={summary.workflowMode}>
        <FieldRow
          label="Canonical workflows"
          value="Eigenmodes modal FMR + FrequencyResponse driven FMR"
        />
        <FieldRow label="Active chart route" value={summary.activeChartRoute} />
        <FieldRow
          label="Modal spectrum"
          value={`${summary.modalModeCount} mode(s), ${summary.modalFieldCount} field-ready`}
        />
        <FieldRow
          label="Driven sweep"
          value={`${summary.responsePointCount} frequency point(s), ${summary.responseSeriesCount} observable series`}
        />
        <FieldRow
          label="Peak comparison"
          value={`${summary.modalPeakCount} modal peak(s), ${summary.drivenPeakCount} driven peak(s); ${summary.comparisonState}`}
        />
        <FieldRow
          label="Nearest modal-driven detuning"
          value={summary.detuningSummary}
        />
        <FieldRow
          label="3D visualization"
          value={`${summary.modalFieldCount} mode field(s), ${summary.responseFieldCount} response field(s)`}
        />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
        <FieldRow label="Resources" value={summary.resources} />
      </InspectorGroup>
      <InspectorGroup
        title="FMR workflow actions"
        badge="selection"
      >
        <FmrWorkflowActions />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal Spectrum Preview"
        badge={`${summary.modalModeCount} mode(s)`}
      >
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={plotMode}
          onSelectMode={selectMode}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Driven Response Preview"
        badge={`${summary.responsePointCount} point(s)`}
      >
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={plotResponsePoint}
          onSelectPoint={selectResponsePoint}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Peak Snapshot"
        badge={summary.peakBadge}
      >
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={summary.peaks}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal-Driven Comparison Snapshot"
        badge={summary.comparisonState}
      >
        <FmrComparisonPairTable pairs={summary.comparisonPairs} />
      </InspectorGroup>
    </div>
  );
}

function FmrWorkflowActions() {
  const kernel = useKernel();
  const openNode = (kind: string, label: string, nodeId: string, resourceRef?: string) => {
    kernel.selection.set(
      {
        kind,
        label,
        nodeId,
        objectId: null,
        ref: {
          kind,
          nodeId,
          resourceRef,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open the modal FMR spectrum inspector"
        type="button"
        variant="secondary"
        onClick={() =>
          openNode(
            "results.frequency_domain.fmr_modal_spectrum",
            "FMR Modal Spectrum",
            "results:frequency-domain:fmr:modal-spectrum",
            ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
          )
        }
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open modal spectrum</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open the driven FMR response sweep inspector"
        type="button"
        variant="secondary"
        onClick={() =>
          openNode(
            "results.frequency_domain.fmr_response_sweep",
            "FMR Response Sweep",
            "results:frequency-domain:fmr:response-sweep",
            ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          )
        }
      >
        <Activity size={13} aria-hidden="true" />
        <span>Open response sweep</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open the FMR peak table inspector"
        type="button"
        variant="secondary"
        onClick={() =>
          openNode(
            "results.frequency_domain.fmr_peaks",
            "FMR Peaks",
            "results:frequency-domain:fmr:peaks",
            ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
          )
        }
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open FMR peaks</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open the modal-vs-driven FMR comparison inspector"
        type="button"
        variant="primary"
        onClick={() =>
          openNode(
            "results.frequency_domain.comparison",
            "Modal vs Driven Comparison",
            "results:frequency-domain:comparison",
            ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
          )
        }
      >
        <Activity size={13} aria-hidden="true" />
        <span>Open modal-vs-driven comparison</span>
      </Button>
    </div>
  );
}

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

export function EigenSpectrumInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenSpectrumSummary();
  const kernel = useKernel();
  const plotMode = (
    point: EigenSpectrumPoint,
    action: FrequencyDomainModeTableAction = "phase_rotated_real",
  ): void => {
    if (!eigenModeFieldAvailable(point) || !point.modeFieldId || action === "inspect") return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.spectrum",
      }),
      {
        fieldId: point.modeFieldId,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        phaseRad: 0,
        source: "eigen-mode",
        view: action,
      },
    );
  };

  return (
    <div data-inspector-surface="eigen-spectrum">
      <InspectorGroup title="Eigen Spectrum Workbench" badge={summary.badge}>
        <FieldRow
          label="Canonical object"
          value="StudyIR::Eigenmodes spectrum"
        />
        <FieldRow label="Spectrum resource" value={summary.spectrumResource} />
        <FieldRow
          label="Mode rows"
          value={`${summary.modeCount} mode(s), ${summary.fieldOverlayCount} field payload(s)`}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Primary mode" value={summary.primaryMode} />
        <FieldRow label="Damping coverage" value={summary.dampingCoverage} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Solve status" value={summary.solveStatus} />
        <FieldRow label="Field availability" value={summary.fieldAvailability} />
        <FieldRow label="Spectrum completeness" value={summary.spectrumCompleteness} />
        <FieldRow label="Window certificate" value={summary.windowCertificate} />
        <FieldRow label="Candidate identity" value={summary.candidateIdentity} />
        <FieldRow
          label="3D workflow"
          value="select mode -> plot phase-rotated real field"
        />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
      </InspectorGroup>
      <InspectorGroup title="Spectrum Chart" badge={summary.badge}>
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={(point) => plotMode(point)}
        />
      </InspectorGroup>
      <InspectorGroup title="Mode Table" badge={summary.badge}>
        <FrequencyDomainModeTable
          onPlotMode={plotMode}
          points={summary.spectrumModel.points}
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenModesInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenModesSummary();
  const kernel = useKernel();
  const selectMode = (point: EigenSpectrumPoint): void => {
    const nodeId = `results:eigen:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`;
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${point.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: eigenModeFieldAvailable(point)
            ? point.modeFieldId ?? undefined
            : undefined,
          kind: "results.eigen.mode",
          modeId: point.modeId ?? undefined,
          modeIndex: point.rawModeIndex,
          nodeId,
          resourceRef: eigenModeFieldAvailable(point)
            ? point.modeFieldResourceKey ?? summary.modeTableResource
            : summary.modeTableResource,
          sampleIndex: point.sampleIndex,
          sampleId: point.sampleId ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotMode = (
    point: EigenSpectrumPoint,
    action: FrequencyDomainModeTableAction,
  ): void => {
    if (action === "inspect") {
      selectMode(point);
      return;
    }
    if (!eigenModeFieldAvailable(point) || !point.modeFieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.modes",
      }),
      {
        fieldId: point.modeFieldId,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        phaseRad: 0,
        source: "eigen-mode",
        view: action,
      },
    );
  };

  return (
    <div data-inspector-surface="eigen-modes-browser">
      <InspectorGroup title="Eigen Modes Browser" badge={summary.badge}>
        <FieldRow
          label="Canonical collection"
          value="mode rows from StudyIR::Eigenmodes spectrum"
        />
        <FieldRow label="Mode table resource" value={summary.modeTableResource} />
        <FieldRow label="Mode table" value={summary.modeTable} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow
          label="Default 3D action"
          value="plot phase-rotated real view"
        />
        <FieldRow label="First selectable mode" value={summary.firstSelectableMode} />
        <FieldRow
          label="Selection payload"
          value="modeIndex + sampleIndex + fieldId"
        />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
      </InspectorGroup>
      <InspectorGroup title="Eigen Mode Browser" badge={summary.badge}>
        <FrequencyDomainModeTable
          onPlotMode={plotMode}
          points={summary.spectrumModel.points}
        />
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

export { FmrResponseSweepInspectorPanel } from "./FmrResponseSweepInspectorPanel";

export function FmrPeaksInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFmrResultSummary();
  const kernel = useKernel();
  const selectPeak = (peak: FmrPeakPoint): void => {
    const peakIndex = summary.peaks.indexOf(peak);
    const nodeId = `results:frequency-domain:fmr:peaks:peak:${peakIndex >= 0 ? peakIndex : 0}`;
    kernel.selection.set(
      {
        kind: "results.frequency_domain.fmr_peak",
        label: `${peak.source} peak ${formatFrequency(peak.frequencyHz)}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: peak.fieldId ?? undefined,
          fmrPeakIndex: peakIndex >= 0 ? peakIndex : undefined,
          kind: "results.frequency_domain.fmr_peak",
          nodeId,
          resourceRef: peak.fieldResourceKey ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotPeak = (peak: FmrPeakPoint): void => {
    if (!peak.fieldId) return;
    void kernel.commands.execute(
      peak.source === "modal"
        ? "analysis.eigen.plot-mode-3d"
        : "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr_peaks",
      }),
      {
        fieldId: peak.fieldId,
        frequencyIndex: peak.frequencyPointIndex,
        label: `${peak.source} peak ${formatFrequency(peak.frequencyHz)}`,
        phaseRad: 0,
        source: peak.source === "modal" ? "eigen-mode" : "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-peaks">
      <InspectorGroup title="FMR Peak Control" badge={summary.peakBadge}>
        <FieldRow
          label="Peak workflow"
          value="select peak -> compare modal/driven provenance -> plot field"
        />
        <FieldRow
          label="Peak rows"
          value={`${summary.peakCount} total, ${summary.modalPeakCount} modal, ${summary.drivenPeakCount} driven`}
        />
        <FieldRow
          label="Overlay-ready peaks"
          value={`${summary.peakFieldCount} with field artifacts`}
        />
        <FieldRow
          label="First peak"
          value={summary.firstPeakLabel}
        />
        <FieldRow
          label="Comparison state"
          value={summary.comparisonState}
        />
        <FieldRow
          label="Nearest modal-driven detuning"
          value={summary.detuningSummary}
        />
        <FieldRow
          label="Quality factor coverage"
          value={summary.qualityFactorCoverage}
        />
        <FieldRow
          label="Linked field handoff"
          value={summary.linkedFieldHandoff}
        />
      </InspectorGroup>
      <InspectorGroup title="FMR Peak Browser" badge={summary.peakBadge}>
        <FmrPeakBrowser
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={summary.peaks}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Peak Table"
        badge={`${summary.peakCount} peak(s)`}
      >
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={summary.peaks}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal-Driven Difference Table"
        badge={summary.comparisonState}
      >
        <FmrComparisonPairTable pairs={summary.comparisonPairs} />
      </InspectorGroup>
    </div>
  );
}

function FmrPeakBrowser({
  onPlotPeak,
  onSelectPeak,
  peaks,
}: {
  onPlotPeak: (peak: FmrPeakPoint) => void;
  onSelectPeak: (peak: FmrPeakPoint) => void;
  peaks: readonly FmrPeakPoint[];
}) {
  if (peaks.length === 0) {
    return (
      <EmptyState className="fm-frequency-domain-table-empty" role="status" size="compact" heading="No modal or driven FMR peaks available." />
    );
  }

  const sortedPeaks = peaks.toSorted(
    (left, right) => left.frequencyHz - right.frequencyHz,
  );

  return (
    <div className="fm-frequency-domain-peak-browser">
      {sortedPeaks.map((peak, index) => (
        <article
          className="fm-frequency-domain-peak-card"
          data-source={peak.source}
          data-status={peak.validationStatus}
          key={`${peak.source}:${peak.frequencyHz}:${peak.frequencyPointIndex ?? peak.modeRef?.rawModeIndex ?? index}`}
        >
          <div className="fm-frequency-domain-peak-card__header">
            <div>
              <span className="fm-frequency-domain-peak-card__eyebrow">
                {formatFmrPeakSourceLabel(peak)}
              </span>
              <h4>{formatFrequency(peak.frequencyHz)}</h4>
            </div>
            <Badge variant="secondary">
              {peak.validationStatus}
            </Badge>
          </div>
          <div className="fm-frequency-domain-peak-card__grid">
            <FieldRow label="Target" value={formatFmrPeakTarget(peak)} />
            <FieldRow label="Amplitude" value={formatNumberOrUnavailable(peak.amplitude)} />
            <FieldRow
              label="Power density"
              value={formatPowerDensity(
                peak.absorbedPowerDensity,
                peak.absorbedPowerDensityUnit,
              )}
            />
            <FieldRow label="Linewidth" value={formatFrequency(peak.linewidthHz)} />
            <FieldRow label="Q factor" value={formatFmrPeakQualityFactor(peak)} />
            <FieldRow
              label="3D field"
              value={peak.fieldId ? "field-ready" : "missing"}
            />
          </div>
          <div className="fm-frequency-domain-peak-card__actions">
            <Button
              className="fm-inspector-action-button"
              size="sm"
              title="Select this FMR peak"
              type="button"
              variant="secondary"
              onClick={() => onSelectPeak(peak)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Select</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={!peak.fieldId}
              size="sm"
              title={
                peak.fieldId
                  ? "Plot this FMR peak field in 3D"
                  : "This peak has no linked 3D field payload"
              }
              type="button"
              variant="primary"
              onClick={() => onPlotPeak(peak)}
            >
              <Activity size={13} aria-hidden="true" />
              <span>Plot 3D</span>
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function FmrPeakInspectorPanel(props: InspectorPanelProps) {
  const summary = useFmrPeakSummary(props);

  return (
    <FmrPeakInspector
      actions={<FmrPeakActions summary={summary} />}
      summary={summary}
    />
  );
}

function FmrPeakActions({
  summary,
}: {
  summary: ReturnType<typeof useFmrPeakSummary>;
}) {
  const kernel = useKernel();
  const openSourceInspector = (): void => {
    kernel.selection.set(
      {
        kind: summary.sourceInspectorKind,
        label: summary.sourceInspectorLabel,
        nodeId: summary.sourceInspectorNodeId,
        objectId: null,
        ref: {
          kind: summary.sourceInspectorKind,
          nodeId: summary.sourceInspectorNodeId,
          resourceRef: summary.sourceResource,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const openLinkedTarget = (): void => {
    if (summary.modeRef) {
      const nodeId = `results:eigen:sample:${summary.modeRef.sampleIndex}:mode:${summary.modeRef.rawModeIndex}`;
      kernel.selection.set(
        {
          kind: "results.eigen.mode",
          label: `Mode ${summary.modeRef.rawModeIndex}`,
          nodeId,
          objectId: null,
          ref: {
            fieldId: summary.fieldId ?? undefined,
            kind: "results.eigen.mode",
            modeIndex: summary.modeRef.rawModeIndex,
            nodeId,
            resourceRef: summary.resource,
            sampleIndex: summary.modeRef.sampleIndex,
            type: "frequency-domain",
          },
        },
        "inspector",
      );
      return;
    }

    if (summary.frequencyPointIndex != null) {
      const nodeId = `results:frequency-response:frequency-points:${summary.frequencyPointIndex}`;
      kernel.selection.set(
        {
          kind: "results.frequency_response.frequency_point",
          label: `Frequency point ${summary.frequencyPointIndex}`,
          nodeId,
          objectId: null,
          ref: {
            fieldId: summary.fieldId ?? undefined,
            frequencyIndex: summary.frequencyPointIndex,
            kind: "results.frequency_response.frequency_point",
            nodeId,
            resourceRef: summary.resource,
            type: "frequency-domain",
          },
        },
        "inspector",
      );
    }
  };
  const plotLinkedField = (): void => {
    if (!summary.fieldId) return;
    void kernel.commands.execute(
      summary.modeRef
        ? "analysis.eigen.plot-mode-3d"
        : "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr_peak",
      }),
      {
        fieldId: summary.fieldId,
        frequencyIndex: summary.frequencyPointIndex,
        label: summary.target,
        phaseRad: 0,
        source: summary.modeRef ? "eigen-mode" : "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };
  const linkedTargetLabel = summary.modeRef
    ? "Open linked mode inspector"
    : "Open linked frequency point inspector";

  return (
    <div className="fm-frequency-domain-table__actions">
      <Button
        className="fm-inspector-action-button"
        size="sm"
        title="Open source result surface"
        type="button"
        variant="secondary"
        onClick={openSourceInspector}
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open source result</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        disabled={!summary.hasLinkedTarget}
        size="sm"
        title={linkedTargetLabel}
        type="button"
        variant="secondary"
        onClick={openLinkedTarget}
      >
        <Eye size={13} aria-hidden="true" />
        <span>{linkedTargetLabel}</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        disabled={!summary.fieldId}
        size="sm"
        title={
          summary.fieldId
            ? "Plot linked field in 3D"
            : "This FMR peak has no linked field payload"
        }
        type="button"
        variant="primary"
        onClick={plotLinkedField}
      >
        <Activity size={13} aria-hidden="true" />
        <span>Plot linked field in 3D</span>
      </Button>
    </div>
  );
}

export function FmrComparisonInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFmrComparisonSummary();
  const kernel = useKernel();
  const openModalPair = (pair: FmrModalDrivenComparisonPoint): void => {
    const modeRef = pair.modalPeak.modeRef;
    if (!modeRef) return;
    const nodeId = `results:eigen:sample:${modeRef.sampleIndex}:mode:${modeRef.rawModeIndex}`;
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${modeRef.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: pair.modalPeak.fieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: modeRef.rawModeIndex,
          nodeId,
          resourceRef: pair.modalPeak.fieldResourceKey ?? undefined,
          sampleIndex: modeRef.sampleIndex,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const openDrivenPair = (pair: FmrModalDrivenComparisonPoint): void => {
    const frequencyPointIndex = pair.drivenPeak.frequencyPointIndex;
    if (frequencyPointIndex == null) return;
    const nodeId = `results:frequency-response:frequency-points:${frequencyPointIndex}`;
    kernel.selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: `Frequency point ${frequencyPointIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: pair.drivenPeak.fieldId ?? undefined,
          frequencyIndex: frequencyPointIndex,
          kind: "results.frequency_response.frequency_point",
          nodeId,
          resourceRef: pair.drivenPeak.fieldResourceKey ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotModalPair = (pair: FmrModalDrivenComparisonPoint): void => {
    if (!pair.modalPeak.fieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: pair.modalPeak.fieldId,
        label: formatFmrModalPairLabel(pair),
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const plotDrivenPair = (pair: FmrModalDrivenComparisonPoint): void => {
    if (!pair.drivenPeak.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: pair.drivenPeak.fieldId,
        frequencyIndex: pair.drivenPeak.frequencyPointIndex,
        label: formatFmrDrivenPairLabel(pair),
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-comparison">
      <InspectorGroup
        title="FMR Modal vs Driven Comparison"
        badge={summary.badge}
      >
        <FieldRow
          label="Canonical comparison"
          value="Eigenmodes resonance vs FrequencyResponse peak"
        />
        <FieldRow label="Comparison readiness" value={summary.readiness} />
        <FieldRow label="Modal resonance" value={summary.modalResonance} />
        <FieldRow label="Driven peak" value={summary.drivenPeak} />
        <FieldRow label="Frequency offset" value={summary.frequencyOffset} />
        <FieldRow label="Peak amplitude ratio" value={summary.amplitudeRatio} />
        <FieldRow label="Spatial overlap (eta_j)" value={summary.spatialOverlap} />
        <FieldRow label="Modal field" value={summary.modalOverlay} />
        <FieldRow label="Driven field" value={summary.drivenOverlay} />
        <FieldRow label="Validation state" value={summary.validationState} />
        <FieldRow label="Resources" value={summary.resources} />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Comparison Browser"
        badge={`${summary.pairs.length} pair(s)`}
      >
        <FmrComparisonPairBrowser
          onOpenDriven={openDrivenPair}
          onOpenModal={openModalPair}
          onPlotDriven={plotDrivenPair}
          onPlotModal={plotModalPair}
          pairs={summary.pairs}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal-Driven Pair Table"
        badge={`${summary.pairs.length} pair(s)`}
      >
        <FmrComparisonPairTable pairs={summary.pairs} />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Comparison Actions"
        badge={summary.actionBadge}
      >
        <FieldRow label="Modal target" value={summary.modalActionTarget} />
        <FieldRow label="Driven target" value={summary.drivenActionTarget} />
        <FmrComparisonActions summary={summary} />
      </InspectorGroup>
    </div>
  );
}

function FmrComparisonActions({
  summary,
}: {
  summary: ReturnType<typeof useFmrComparisonSummary>;
}) {
  const kernel = useKernel();
  const openModal = (): void => {
    const modeRef = summary.modalPeakPoint?.modeRef;
    if (!modeRef) return;
    const nodeId = `results:eigen:sample:${modeRef.sampleIndex}:mode:${modeRef.rawModeIndex}`;
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${modeRef.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: summary.modalPeakPoint?.fieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: modeRef.rawModeIndex,
          nodeId,
          resourceRef: summary.modalPeakPoint?.fieldResourceKey ?? undefined,
          sampleIndex: modeRef.sampleIndex,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const openDriven = (): void => {
    const frequencyPointIndex = summary.drivenPeakPoint?.frequencyPointIndex;
    if (frequencyPointIndex == null) return;
    const nodeId = `results:frequency-response:frequency-points:${frequencyPointIndex}`;
    kernel.selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: `Frequency point ${frequencyPointIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: summary.drivenPeakPoint?.fieldId ?? undefined,
          frequencyIndex: frequencyPointIndex,
          kind: "results.frequency_response.frequency_point",
          nodeId,
          resourceRef: summary.drivenPeakPoint?.fieldResourceKey ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotModal = (): void => {
    if (!summary.modalPeakPoint?.fieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: summary.modalPeakPoint.fieldId,
        label: summary.modalActionTarget,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const plotDriven = (): void => {
    if (!summary.drivenPeakPoint?.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: summary.drivenPeakPoint.fieldId,
        frequencyIndex: summary.drivenPeakPoint.frequencyPointIndex,
        label: summary.drivenActionTarget,
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      <Button
        className="fm-inspector-action-button"
        disabled={!summary.modalPeakPoint?.modeRef}
        size="sm"
        title={
          summary.modalPeakPoint?.modeRef
            ? "Open the modal eigenmode behind this comparison"
            : "No modal eigenmode is linked to this comparison"
        }
        type="button"
        variant="secondary"
        onClick={openModal}
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open modal mode</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        disabled={summary.drivenPeakPoint?.frequencyPointIndex == null}
        size="sm"
        title={
          summary.drivenPeakPoint?.frequencyPointIndex != null
            ? "Open the driven response point behind this comparison"
            : "No driven response point is linked to this comparison"
        }
        type="button"
        variant="secondary"
        onClick={openDriven}
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open driven point</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        disabled={!summary.modalPeakPoint?.fieldId}
        size="sm"
        title={
          summary.modalPeakPoint?.fieldId
            ? "Plot the modal comparison field in 3D"
            : "Modal comparison field is missing"
        }
        type="button"
        variant="primary"
        onClick={plotModal}
      >
        <Activity size={13} aria-hidden="true" />
        <span>Plot modal field</span>
      </Button>
      <Button
        className="fm-inspector-action-button"
        disabled={!summary.drivenPeakPoint?.fieldId}
        size="sm"
        title={
          summary.drivenPeakPoint?.fieldId
            ? "Plot the driven comparison field in 3D"
            : "Driven comparison field is missing"
        }
        type="button"
        variant="primary"
        onClick={plotDriven}
      >
        <Activity size={13} aria-hidden="true" />
        <span>Plot driven field</span>
      </Button>
    </div>
  );
}

function FmrComparisonPairBrowser({
  onOpenDriven,
  onOpenModal,
  onPlotDriven,
  onPlotModal,
  pairs,
}: {
  onOpenDriven: (pair: FmrModalDrivenComparisonPoint) => void;
  onOpenModal: (pair: FmrModalDrivenComparisonPoint) => void;
  onPlotDriven: (pair: FmrModalDrivenComparisonPoint) => void;
  onPlotModal: (pair: FmrModalDrivenComparisonPoint) => void;
  pairs: readonly FmrModalDrivenComparisonPoint[];
}) {
  if (pairs.length === 0) {
    return (
      <EmptyState className="fm-frequency-domain-table-empty" role="status" size="compact" heading="No modal-driven FMR comparison pairs available." />
    );
  }

  return (
    <div className="fm-frequency-domain-comparison-browser">
      {pairs.map((pair) => (
        <article
          className="fm-frequency-domain-comparison-card"
          data-status={
            pair.modalPeak.fieldId && pair.drivenPeak.fieldId
              ? "ready"
              : "partial"
          }
          key={`${pair.modalPeak.frequencyHz}:${pair.modalPeak.modeRef?.sampleIndex ?? "sample"}:${pair.modalPeak.modeRef?.rawModeIndex ?? "mode"}:${pair.drivenPeak.frequencyHz}:${pair.drivenPeak.frequencyPointIndex ?? "point"}`}
        >
          <div className="fm-frequency-domain-comparison-card__header">
            <div>
              <span className="fm-frequency-domain-comparison-card__eyebrow">
                modal-driven detuning
              </span>
              <h4>{formatFrequency(pair.detuningHz)}</h4>
            </div>
            <Badge variant="secondary">
              {pair.modalPeak.validationStatus}/{pair.drivenPeak.validationStatus}
            </Badge>
          </div>
          <div className="fm-frequency-domain-comparison-card__grid">
            <FieldRow label="Modal" value={formatFmrModalPairLabel(pair)} />
            <FieldRow label="Driven" value={formatFmrDrivenPairLabel(pair)} />
            <FieldRow
              label="Modal field"
              value={pair.modalPeak.fieldId ? "field-ready" : "missing"}
            />
            <FieldRow
              label="Driven field"
              value={pair.drivenPeak.fieldId ? "field-ready" : "missing"}
            />
            <FieldRow
              label="Amplitude ratio"
              value={formatFmrPairAmplitudeRatio(pair)}
            />
            <FieldRow
              label="Field handoff"
              value={formatFmrPairFieldHandoff(pair)}
            />
          </div>
          <div className="fm-frequency-domain-comparison-card__actions">
            <Button
              className="fm-inspector-action-button"
              disabled={!pair.modalPeak.modeRef}
              size="sm"
              title={
                pair.modalPeak.modeRef
                  ? "Open the modal eigenmode in the inspector"
                  : "This comparison has no linked modal eigenmode"
              }
              type="button"
              variant="secondary"
              onClick={() => onOpenModal(pair)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Modal</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={pair.drivenPeak.frequencyPointIndex == null}
              size="sm"
              title={
                pair.drivenPeak.frequencyPointIndex != null
                  ? "Open the driven response point in the inspector"
                  : "This comparison has no linked driven response point"
              }
              type="button"
              variant="secondary"
              onClick={() => onOpenDriven(pair)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Driven</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={!pair.modalPeak.fieldId}
              size="sm"
              title={
                pair.modalPeak.fieldId
                  ? "Plot the modal comparison field in 3D"
                  : "Modal comparison field is missing"
              }
              type="button"
              variant="primary"
              onClick={() => onPlotModal(pair)}
            >
              <Activity size={13} aria-hidden="true" />
              <span>Plot modal</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={!pair.drivenPeak.fieldId}
              size="sm"
              title={
                pair.drivenPeak.fieldId
                  ? "Plot the driven comparison field in 3D"
                  : "Driven comparison field is missing"
              }
              type="button"
              variant="primary"
              onClick={() => onPlotDriven(pair)}
            >
              <Activity size={13} aria-hidden="true" />
              <span>Plot driven</span>
            </Button>
          </div>
        </article>
      ))}
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

export function FrequencyDomainCalculationModesResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyDomainCalculationModesInspectorPanel {...props} />;
}

export function FrequencyDomainFmrResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FmrOverviewInspectorPanel {...props} />;
}

export function FrequencyDomainDispersionResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyDomainDispersionInspectorPanel {...props} />;
}

export function FrequencyDomainResponseMapResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyDomainResponseMapInspectorPanel {...props} />;
}

export function EigenSpectrumResourceInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenSpectrumSummary();

  return (
    <div data-inspector-surface="eigen-spectrum-resource">
      <InspectorGroup title="Eigen Spectrum Resource" badge={summary.badge}>
        <FieldRow label="Resource endpoint" value={summary.spectrumResource} />
        <FieldRow
          label="Mode rows"
          value={`${summary.modeCount} mode(s), ${summary.fieldOverlayCount} field payload(s)`}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Solve status" value={summary.solveStatus} />
        <FieldRow label="Field availability" value={summary.fieldAvailability} />
        <FieldRow label="Spectrum completeness" value={summary.spectrumCompleteness} />
        <FieldRow label="Window certificate" value={summary.windowCertificate} />
        <FieldRow label="Candidate identity" value={summary.candidateIdentity} />
      </InspectorGroup>
    </div>
  );
}

export function EigenBranchesResourceInspectorPanel(props: InspectorPanelProps) {
  return <EigenBranchesInspectorPanel {...props} />;
}

export function EigenDispersionResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyDomainDispersionInspectorPanel {...props} />;
}

export function EigenDiagnosticsResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <EigenDiagnosticsInspectorPanel {...props} />;
}

export function EigenModeMetadataResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <EigenModeInspectorPanel {...props} />;
}

export function EigenModeFieldResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useEigenSampleJobSummary();

  return (
    <div data-inspector-surface="eigen-mode-field-resource">
      <InspectorGroup title="Eigen Mode Field Resource" badge={summary.modeFields}>
        <FieldRow
          label="Field payload contract"
          value="phase-rotated real / real / imag / abs / phase"
        />
        <FieldRow label="Mode fields" value={summary.modeFields} />
        <FieldRow label="Output resources" value={summary.outputResources} />
        <FieldRow label="Viewport handoff" value="mode selection -> 3D field" />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseSweepResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseSweepSummary();

  return (
    <div data-inspector-surface="frequency-response-sweep-resource">
      <InspectorGroup
        title="Frequency Response Sweep Resource"
        badge={summary.badge}
      >
        <FieldRow label="Sweep endpoint" value={summary.resourceKey} />
        <FieldRow
          label="Solved frequencies"
          value={`${summary.pointCount} point(s), ${summary.seriesStatus.startsWith("1 series") ? "1 observable series" : summary.seriesStatus}`}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Frequency points" value={summary.pointCount} />
        <FieldRow label="Observable series" value={summary.seriesStatus} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseProgressResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseProgressSummary();

  return (
    <div data-inspector-surface="frequency-response-progress-resource">
      <InspectorGroup
        title="Frequency Response Progress Resource"
        badge={summary.badge}
      >
        <StudyProgressBar
          label="Frequency response sweep progress"
          statusLabel={summary.progressLabel}
          value={summary.progressPercent}
        />
        <FieldRow
          label="Progress endpoint"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH}
        />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Solver progress" value={summary.solverProgress} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
        <FieldRow label="Reason" value={summary.reason} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseCancelRequestedResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyResponseCancelRequestedInspectorPanel {...props} />;
}

export function FrequencyResponseFrequencyPointResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyResponsePointInspectorPanel {...props} />;
}

export function FrequencyResponseFieldResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseFrequencyPointsSummary();

  return (
    <div data-inspector-surface="frequency-response-field-resource">
      <InspectorGroup
        title="Frequency Response Field Resource"
        badge={summary.fieldOverlays}
      >
        <FieldRow
          label="Field endpoint"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH}
        />
        <FieldRow label="Response fields" value={summary.fieldOverlays} />
        <FieldRow label="3D workflow" value={summary.workflow} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseObservablesResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyResponseFrequencyPointsInspectorPanel {...props} />;
}

export function FrequencyResponseDiagnosticsResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  return <FrequencyResponseDiagnosticsInspectorPanel {...props} />;
}
