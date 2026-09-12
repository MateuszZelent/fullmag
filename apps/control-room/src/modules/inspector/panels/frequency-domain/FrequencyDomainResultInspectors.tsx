"use client";

/**
 * Dedicated frequency-domain result / resource / job / diagnostic inspector
 * panel components. Each non-authoring frequency-domain node kind receives its
 * own component reference so the registry cannot silently route a new kind to a
 * generic fallback.
 */

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FmrPeakInspector } from "./FmrPeakInspector";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StudyProgressBar } from "../StudyProgressBar";
import { Activity, Eye, Play, RotateCw } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDiagnosticsResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseDiagnosticsResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseFrequencyPointResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchSelectionRef,
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFrequencyResponseChartModel,
  buildFmrModalDrivenComparisonModel,
  buildFmrPeakTableModel,
  frequencyDomainManifestPayload,
  frequencyResponseSeriesUnit,
  responseFieldResourcesFromManifest,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  EigenBranch,
  EigenDispersionPoint,
  EigenSpectrumPoint,
  FmrModalDrivenComparisonPoint,
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  formatFrequencyHz,
  formatFrequencyRangeHz,
} from "@/shared/domain/analysis/frequencyUnits";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  FrequencyDomainModeDisplayControls,
  analysisFieldViewLabel,
  isActiveAnalysisFieldView,
  normalizeAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "../FrequencyDomainModeDisplayControls";
import {
  FrequencyDomainDispersionChart,
  FrequencyDomainResponseChart,
  FrequencyDomainSpectrumChart,
} from "../FrequencyDomainCharts";
import {
  FrequencyDomainBranchTable,
  FrequencyDomainFmrPeakTable,
  FrequencyDomainModeTable,
  FrequencyDomainResponsePointTable,
  type FrequencyDomainModeTableAction,
  type FrequencyDomainResponsePointAction,
} from "../FrequencyDomainTables";
import {
  buildFrequencyDomainCalculationModeRows,
  periodicStatusView,
  type FrequencyDomainCalculationModeRow,
} from "../frequencyDomainInspectorModel";
import {
  canPlotSelectedFieldIn3D,
  modeFieldComponentOptions,
  selectedField3DPlotStatus,
} from "./FrequencyDomainHelpers";
import { EigenModeInspectorPanel } from "./EigenModeInspectorPanel";

export { FmrModalSpectrumInspectorPanel } from "./FmrModalSpectrumInspectorPanel";
export { EigenBranchInspectorPanel } from "./EigenBranchInspectorPanel";
export { EigenDispersionInspectorPanel } from "./EigenDispersionInspectorPanel";
export { EigenModeInspectorPanel } from "./EigenModeInspectorPanel";

export function buildFrequencyResponsePlotCommandInput({
  fieldId,
  frequencyIndex,
  label,
  phaseRad,
  view,
}: {
  fieldId: string;
  frequencyIndex?: number | null;
  label: string;
  phaseRad: number;
  view: FrequencyDomainResponsePointAction;
}) {
  return {
    fieldId,
    ...(frequencyIndex == null ? {} : { frequencyIndex }),
    label,
    phaseRad,
    source: "frequency-response" as const,
    view,
  };
}

// ---------------------------------------------------------------------------
// Primary result inspector panels — these are referenced by name in the
// registry and tests. The FMR/eigen/response panels below are dedicated
// surfaces; generic fallback is kept only for still-transitional groups.
// ---------------------------------------------------------------------------

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
      <div className="fm-frequency-domain-table-empty" role="status">
        No modal-driven FMR pairs available.
      </div>
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
          fieldId: point.modeFieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: point.rawModeIndex,
          nodeId,
          resourceRef: point.modeFieldResourceKey ?? summary.spectrumResource,
          sampleIndex: point.sampleIndex,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotMode = (point: EigenSpectrumPoint): void => {
    if (!point.modeFieldId) return;
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
  void props;
  const summary = useFrequencyDomainDispersionSummary();
  const kernel = useKernel();
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
        <FrequencyDomainDispersionChart model={summary.dispersionModel} />
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

export function EigenKPathInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFrequencyDomainDispersionSummary();

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
        <FrequencyDomainDispersionChart model={summary.dispersionModel} />
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
    if (!point.modeFieldId || action === "inspect") return;
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
          fieldId: point.modeFieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: point.rawModeIndex,
          nodeId,
          resourceRef: point.modeFieldResourceKey ?? summary.modeTableResource,
          sampleIndex: point.sampleIndex,
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
    if (!point.modeFieldId) return;
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
      <div className="fm-frequency-domain-table-empty" role="status">
        No modal or driven FMR peaks available.
      </div>
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
      <div className="fm-frequency-domain-table-empty" role="status">
        No modal-driven FMR comparison pairs available.
      </div>
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

export function FrequencyResponsePointInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponsePointSummary(props);
  const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
    activation: {
      commandId: "analysis.frequency-response.plot-response-field-3d",
      componentBasis: summary.componentBasis,
      componentCount: summary.componentCount,
      defaultPhaseRad: summary.defaultPhaseRad,
      fieldId: summary.fieldId,
      label: summary.frequencyDisplay,
      source: "frequency-response",
      valueKind: summary.valueKind,
    },
    sourceDetail: "results.frequency_response.frequency_point",
  });

  return (
    <div data-inspector-surface="frequency-response-point">
      <InspectorGroup
        title="Response Frequency Point Control"
        badge={summary.badge}
      >
        <FieldRow label="Canonical object" value="FrequencyResponse point" />
        <FieldRow label="Frequency" value={summary.frequencyDisplay} />
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Artifact" value={summary.artifactPath} />
        <FieldRow label="Observable rows" value={summary.observableRows} />
        <FieldRow label="Response amplitude" value={summary.amplitude} />
        <FieldRow label="Response phase" value={summary.phase} />
        <FieldRow
          label="Absorbed power density"
          value={summary.absorbedPowerDensity}
        />
        <FieldRow label="Residual" value={summary.residual} />
        <FieldRow label="3D field" value={summary.fieldStatus} />
        <FieldRow label="Available field views" value={summary.availableViews} />
        <FieldRow label="Provenance" value={summary.provenance} />
      </InspectorGroup>
      <InspectorGroup
        title="Response Point 3D Visualization"
        badge={summary.actionBadge}
      >
        <FieldRow label="Field ID" value={summary.fieldIdLabel} />
        <FieldRow label="Field resource" value={summary.fieldResource} />
        <FieldRow label="Default view" value={summary.defaultViewLabel} />
        <FieldRow label="Default phase" value={summary.defaultPhaseLabel} />
        <FieldRow
          label="Complex response convention"
          value="phasor response; view controls select real, imaginary, magnitude, phase, or phase-rotated real"
        />
        <FrequencyDomainModeDisplayControls
          componentOptions={summary.componentOptions}
          disabled={!summary.field3DReady}
          labelPrefix="Response point"
          settings={modeDisplaySettings}
          viewDefaultValue={summary.defaultView}
          viewOptions={summary.availableViewValues}
        />
        <FrequencyResponsePoint3DActions
          settings={modeDisplaySettings}
          summary={summary}
        />
      </InspectorGroup>
    </div>
  );
}

function FrequencyResponsePoint3DActions({
  settings,
  summary,
}: {
  settings: ReturnType<typeof useFrequencyDomainModeDisplaySettings>;
  summary: ReturnType<typeof useFrequencyResponsePointSummary>;
}) {
  const kernel = useKernel();
  const plot = (
    view:
      | "phase_rotated_real"
      | "real"
      | "imag"
      | "abs"
      | "phase"
      | "animate",
  ): void => {
    if (!summary.field3DReady) return;
    const animate = view === "animate";
    void kernel.commands.execute(
      animate
        ? "analysis.frequency-domain.set-3d-animation"
        : "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_point",
      }),
      {
        animatePhase: animate ? true : undefined,
        animationRateHz: animate ? 1 : undefined,
        fieldId: summary.fieldId,
        frequencyIndex: summary.frequencyIndex,
        label: summary.frequencyDisplay,
        phaseRad: summary.defaultPhaseRad,
        source: "frequency-response",
        view: animate ? "phase_rotated_real" : view,
      },
    );
  };
  const stopAnimation = (): void => {
    if (!summary.field3DReady) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.stop-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_point",
      }),
    );
  };
  const disabled = !summary.field3DReady;
  const actions = [
    {
      icon: RotateCw,
      label: "Rotated",
      title: "Plot response field with phase-rotated real display",
      variant: "secondary" as const,
      view: "phase_rotated_real" as const,
    },
    {
      icon: Activity,
      label: "Real",
      title: "Plot response field real component",
      variant: "secondary" as const,
      view: "real" as const,
    },
    {
      icon: Activity,
      label: "Imag",
      title: "Plot response field imaginary component",
      variant: "secondary" as const,
      view: "imag" as const,
    },
    {
      icon: Activity,
      label: "Abs",
      title: "Plot response field complex magnitude",
      variant: "secondary" as const,
      view: "abs" as const,
    },
    {
      icon: RotateCw,
      label: "Phase",
      title: "Plot response field phase",
      variant: "secondary" as const,
      view: "phase" as const,
    },
    {
      icon: Play,
      label: "Animate",
      title: "Animate response field phase in 3D",
      variant: "secondary" as const,
      view: "animate" as const,
    },
  ];

  return (
    <div
      aria-label="Response point 3D visualization controls"
      className="fm-frequency-domain-visualization-actions"
    >
      {actions.map((entry) => {
        const Icon = entry.icon;
        const isActive =
          entry.view !== "animate" &&
          isActiveAnalysisFieldView(
            settings,
            summary.fieldId,
            "frequency-response",
            entry.view,
          );
        return (
          <Button
            aria-label={entry.title}
            aria-pressed={isActive}
            className="fm-inspector-action-button"
            disabled={disabled}
            key={entry.view}
            size="sm"
            title={disabled ? summary.field3DStatus : entry.title}
            type="button"
            variant={isActive ? "primary" : entry.variant}
            onClick={() => plot(entry.view)}
          >
            <Icon aria-hidden="true" size={13} />
            <span>{entry.label}</span>
          </Button>
        );
      })}
      <Button
        aria-label="Stop response field animation"
        className="fm-inspector-action-button"
        disabled={disabled}
        size="sm"
        title={disabled ? summary.field3DStatus : "Stop response field animation"}
        type="button"
        variant="secondary"
        onClick={stopAnimation}
      >
        <RotateCw aria-hidden="true" size={13} />
        <span>Stop animate</span>
      </Button>
    </div>
  );
}

export function FrequencyResponseFrequencyPointsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  return <FrequencyResponsePointCollection surface="frequency-points" />;
}

export function FrequencyResponseFieldsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  return <FrequencyResponsePointCollection surface="response-fields" />;
}

function FrequencyResponsePointCollection({
  surface,
}: {
  surface: "frequency-points" | "response-fields";
}) {
  const summary = useFrequencyResponseFrequencyPointsSummary();
  const kernel = useKernel();
  const plotPoint = (
    point: FrequencyResponsePoint,
    action: FrequencyDomainResponsePointAction,
  ): void => {
    if (!point.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_points",
      }),
      buildFrequencyResponsePlotCommandInput({
        fieldId: point.fieldId,
        frequencyIndex: point.frequencyIndex,
        label: `response ${formatFrequency(point.frequencyHz)}`,
        phaseRad: 0,
        view: action,
      }),
    );
  };

  return (
    <div data-inspector-surface={`frequency-response-${surface}`}>
      <InspectorGroup
        title={surface === "response-fields" ? "Response Field Resources" : "Response Frequency Points Table"}
        badge={summary.badge}
      >
        <FieldRow
          label="Canonical collection"
          value="FrequencyResponse solved points"
        />
        <FieldRow label="Sweep resource" value={summary.resourceKey} />
        <FieldRow label="Solved frequencies" value={summary.solvedFrequencies} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Amplitude range" value={summary.amplitudeRange} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Field payloads" value={summary.fieldOverlays} />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
        <FieldRow label="3D workflow" value={summary.workflow} />
      </InspectorGroup>
      <InspectorGroup
        title={surface === "response-fields" ? "Available Response Fields" : "Response Frequency Point Table"}
        badge={summary.badge}
      >
        <FrequencyDomainResponsePointTable
          absorbedPowerDensityUnit={summary.absorbedPowerDensityUnit}
          amplitudeUnit={summary.amplitudeUnit}
          onPlotResponsePoint={plotPoint}
          points={summary.responseModel.points}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseProgressInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseProgressSummary();

  return (
    <div data-inspector-surface="frequency-response-progress">
      <InspectorGroup title="Response Sweep Progress" badge={summary.badge}>
        <StudyProgressBar
          label="Frequency response sweep progress"
          statusLabel={summary.progressLabel}
          value={summary.progressPercent}
        />
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Solver progress" value={summary.solverProgress} />
        <FieldRow label="Complete" value={summary.complete} />
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

export function FrequencyResponseCancelRequestedInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseCancelRequestedSummary();

  return (
    <div data-inspector-surface="frequency-response-cancel-requested">
      <InspectorGroup
        title="Response Sweep Cancellation"
        badge={summary.badge}
      >
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Solver progress" value={summary.solverProgress} />
        <FieldRow label="Complete" value={summary.complete} />
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

export function FrequencyResponseObservableInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseObservableSummary(props);

  return (
    <div data-inspector-surface="frequency-response-observable">
      <InspectorGroup
        title="Response Observable Control"
        badge={summary.badge}
      >
        <FieldRow label="Selected Response Observable" value={summary.observableId} />
        <FieldRow label="Canonical object" value="FrequencyResponse observable" />
        <FieldRow label="Observable" value={summary.observableId} />
        <FieldRow label="Sweep resource" value={summary.resourceKey} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Point count" value={summary.pointCount} />
        <FieldRow label="Mean amplitude" value={summary.meanAmplitude} />
        <FieldRow label="Peak amplitude" value={summary.peakAmplitude} />
        <FieldRow label="Phase range" value={summary.phaseRange} />
        <FieldRow
          label="Max absorbed power density"
          value={summary.maxAbsorbedPowerDensity}
        />
        <FieldRow label="Field payloads" value={summary.fieldOverlayStatus} />
        <FieldRow label="Chart series" value={summary.chartSeriesStatus} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseObservablesInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseSweepSummary();

  return (
    <div data-inspector-surface="frequency-response-observables">
      <InspectorGroup
        title="Frequency Response Observables"
        badge={summary.seriesStatus}
      >
        <FieldRow label="Observable series" value={summary.seriesStatus} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Frequency points" value={summary.pointCount} />
        <FieldRow label="Field payloads" value={summary.fieldOverlayStatus} />
        <FieldRow label="Peak response" value={summary.peakResponse} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseSweepInspectorPanel(props: InspectorPanelProps) {
  void props;
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const missingExcitation = isDrivenExcitationMissing(manifestPayload);

  const summary = useFrequencyResponseSweepSummary();
  const kernel = useKernel();
  const plotPoint = (point: FrequencyResponsePoint): void => {
    if (!point.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.sweep",
      }),
      buildFrequencyResponsePlotCommandInput({
        fieldId: point.fieldId,
        frequencyIndex: point.frequencyIndex,
        label: `response ${formatFrequency(point.frequencyHz)}`,
        phaseRad: 0,
        view: "phase_rotated_real",
      }),
    );
  };

  if (missingExcitation) {
    return (
      <div data-inspector-surface="frequency-response-sweep">
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
    <div data-inspector-surface="frequency-response-sweep">
      <InspectorGroup
        title="Driven Response Sweep Control"
        badge={summary.badge}
      >
        <FieldRow label="Canonical object" value="FrequencyResponse sweep" />
        <FieldRow label="Sweep resource" value={summary.resourceKey} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Frequency points" value={summary.pointCount} />
        <FieldRow label="Observable series" value={summary.seriesStatus} />
        <FieldRow
          label="Response series controls"
          value={summary.responseSeriesControls}
        />
        <FieldRow
          label="Susceptibility component"
          value={summary.susceptibilityComponent}
        />
        <FieldRow label="Phase coverage" value={summary.phaseCoverage} />
        <FieldRow
          label="Absorbed-power coverage"
          value={summary.absorbedPowerCoverage}
        />
        <FieldRow label="Peak response" value={summary.peakResponse} />
        <FieldRow
          label="Max absorbed power density"
          value={summary.maxAbsorbedPowerDensity}
        />
        <FieldRow label="Field payloads" value={summary.fieldOverlayStatus} />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
      </InspectorGroup>
      <InspectorGroup title="Driven Response Chart" badge={summary.badge}>
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={plotPoint}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Driven Response Point Table"
        badge={summary.badge}
      >
        <FrequencyDomainResponsePointTable
          absorbedPowerDensityUnit={summary.absorbedPowerDensityUnit}
          amplitudeUnit={summary.amplitudeUnit}
          onPlotResponsePoint={(point, action) => {
            if (!point.fieldId) return;
            void kernel.commands.execute(
              "analysis.frequency-response.plot-response-field-3d",
              createCommandContext("inspector", kernel, {
                sourceDetail: "results.frequency_response.sweep",
              }),
              buildFrequencyResponsePlotCommandInput({
                fieldId: point.fieldId,
                frequencyIndex: point.frequencyIndex,
                label: `response ${formatFrequency(point.frequencyHz)}`,
                phaseRad: 0,
                view: action,
              }),
            );
          }}
          points={summary.responseModel.points}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseDiagnosticsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseDiagnosticsSummary();

  return (
    <div data-inspector-surface="frequency-response-diagnostics">
      <InspectorGroup
        title="Frequency Response Diagnostics"
        badge={summary.badge}
      >
        <FieldRow
          label="Driven availability"
          value={summary.drivenAvailability}
        />
        <FieldRow label="Sweep progress" value={summary.sweepProgress} />
        <FieldRow label="Cancel state" value={summary.cancelState} />
        <FieldRow label="Response fields" value={summary.responseFields} />
        <FieldRow
          label="Krylov preconditioner"
          value={summary.krylovPreconditioner}
        />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Response artifact" value={summary.responseArtifact} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainJobsOverviewInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainJobsSummary();

  return (
    <div data-inspector-surface="frequency-domain-jobs-overview">
      <InspectorGroup title="Frequency-Domain Job Queue" badge={summary.badge}>
        <FieldRow label="Stage run" value={summary.stageRun} />
        <FieldRow label="Eigen samples" value={summary.eigenSamples} />
        <FieldRow label="Response frequencies" value={summary.responseFrequencies} />
        <FieldRow label="Response progress" value={summary.responseProgress} />
        <FieldRow label="Cancel checkpoint" value={summary.cancelCheckpoint} />
        <FieldRow label="Artifact export" value={summary.artifactExport} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainStageRunJobInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainRunSummary();

  return (
    <div data-inspector-surface="frequency-domain-stage-run-job">
      <InspectorGroup
        title="Frequency-Domain Stage Run Job"
        badge={summary.calculationMode}
      >
        <FieldRow label="Requested stage" value={summary.stageKind} />
        <FieldRow label="Calculation mode" value={summary.calculationMode} />
        <FieldRow label="Response lane" value={summary.responseLane} />
        <FieldRow label="Eigen lane" value={summary.eigenLane} />
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow
          label="Run handoff"
          value="publish manifest and stage artifacts"
        />
      </InspectorGroup>
    </div>
  );
}

export function EigenSampleJobInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenSampleJobSummary();

  return (
    <div data-inspector-surface="eigen-sample-job">
      <InspectorGroup title="Eigen k-Sample Job" badge={summary.badge}>
        <FieldRow label="k-path samples" value={summary.kPathSamples} />
        <FieldRow label="Branch tracking" value={summary.branchTracking} />
        <FieldRow label="Mode fields" value={summary.modeFields} />
        <FieldRow label="Solver lane" value={summary.solverLane} />
        <FieldRow label="Output resources" value={summary.outputResources} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseFrequencyJobInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseFrequencyJobSummary();

  return (
    <div data-inspector-surface="frequency-response-frequency-job">
      <InspectorGroup
        title="Response Frequency Solve Job"
        badge={summary.badge}
      >
        <FieldRow
          label="Frequency work units"
          value={summary.frequencyWorkUnits}
        />
        <FieldRow label="Sweep progress" value={summary.sweepProgress} />
        <FieldRow label="Cancel checkpoint" value={summary.cancelCheckpoint} />
        <FieldRow label="Sweep resource" value={summary.sweepResource} />
        <FieldRow label="Field artifacts" value={summary.fieldArtifacts} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Solver lane" value={summary.solverLane} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseProgressJobInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseProgressSummary();

  return (
    <div data-inspector-surface="frequency-response-progress-job">
      <InspectorGroup
        title="Response Sweep Progress Job"
        badge={summary.badge}
      >
        <StudyProgressBar
          label="Frequency response sweep progress"
          statusLabel={summary.progressLabel}
          value={summary.progressPercent}
        />
        <FieldRow label="Progress resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Solver progress" value={summary.solverProgress} />
        <FieldRow label="Runtime state" value={summary.runtimeState} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainArtifactExportJobInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainExportsSummary();

  return (
    <div data-inspector-surface="frequency-domain-artifact-export-job">
      <InspectorGroup
        title="Frequency-Domain Artifact Export Job"
        badge={summary.badge}
      >
        <FieldRow label="Export bundle" value={summary.bundle} />
        <FieldRow label="Manifest" value={summary.manifest} />
        <FieldRow label="Modal spectrum" value={summary.modalSpectrum} />
        <FieldRow label="Modal branches" value={summary.modalBranches} />
        <FieldRow label="Driven sweep" value={summary.drivenSweep} />
        <FieldRow label="Field payloads" value={summary.fieldPayloads} />
        <FieldRow label="API resources" value={summary.apiResources} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainDiagnosticsOverviewInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainDiagnosticsSummary();

  return (
    <div data-inspector-surface="frequency-domain-diagnostics-overview">
      <InspectorGroup
        title="Frequency-Domain Diagnostics Overview"
        badge={summary.badge}
      >
        <FieldRow label="Capability gates" value={summary.capabilityGates} />
        <FieldRow label="Solver state" value={summary.solverState} />
        <FieldRow label="Artifacts" value={summary.artifacts} />
        <FieldRow label="API resources" value={summary.apiResources} />
        <FieldRow label="Visualization" value={summary.visualization} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainCapabilitiesDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainCapabilitiesDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-capabilities-diagnostic">
      <InspectorGroup
        title="Frequency-Domain Capability Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Modal lane" value={summary.modalLane} />
        <FieldRow label="Driven lane" value={summary.drivenLane} />
        <FieldRow label="Boundary gates" value={summary.boundaryGates} />
        <FieldRow label="Demag gates" value={summary.demagGates} />
        <FieldRow label="Visualization gates" value={summary.visualizationGates} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainEquilibriumDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainEquilibriumDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-equilibrium-diagnostic">
      <InspectorGroup
        title="Frequency-Domain Equilibrium Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Equilibrium source" value={summary.source} />
        <FieldRow label="Stage kind" value={summary.stageKind} />
        <FieldRow label="Modal readiness" value={summary.modalReadiness} />
        <FieldRow label="Response readiness" value={summary.responseReadiness} />
        <FieldRow label="Tangent contract" value={summary.tangentContract} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainOperatorDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const diagnostics = Array.isArray(manifestPayload?.diagnostics) ? manifestPayload.diagnostics : [];
  const dmiWarning = diagnostics.find(d => record(d)?.id === "frequency_domain.dmi_boundary_condition_uncertain");
  const summary = useFrequencyDomainOperatorDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-operator-diagnostic">
      <InspectorGroup
        title="Frequency-Domain Operator Diagnostics"
        badge={summary.badge}
      >
        {dmiWarning && (
          <div className="fm-inspector-alert fm-alert-warning">
            <div className="fm-fd-alert__title">DMI BC uncertain</div>
            <div className="fm-fd-alert__row"><strong>Severity:</strong> warning</div>
            <div className="fm-fd-alert__row"><strong>Message:</strong> Frequency-domain DMI boundary conditions are not yet fully resolved. Use with caution.</div>
            <div className="fm-fd-alert__row"><strong>ID:</strong> frequency_domain.dmi_boundary_condition_uncertain</div>
          </div>
        )}
        <FieldRow label="Operator family" value={summary.operatorFamily} />
        <FieldRow label="Normalization" value={summary.normalization} />
        <FieldRow label="Phase convention" value={summary.phaseConvention} />
        <FieldRow label="Demag-k gate" value={summary.demagKGate} />
        <FieldRow label="Boundary policy" value={summary.boundaryPolicy} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainSolverDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainSolverDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-solver-diagnostic">
      <InspectorGroup
        title="Frequency-Domain Solver Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Execution lane" value={summary.executionLane} />
        <FieldRow label="Modal transport" value={summary.modalTransport} />
        <FieldRow
          label="Production CPU gate"
          value={summary.productionCpuGate}
        />
        <FieldRow label="Response residuals" value={summary.responseResiduals} />
        <FieldRow label="Modal residuals" value={summary.modalResiduals} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Cancel state" value={summary.cancelState} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainArtifactsDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainExportsSummary();

  return (
    <div data-inspector-surface="frequency-domain-artifacts-diagnostic">
      <InspectorGroup
        title="Frequency-Domain Artifact Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Manifest" value={summary.manifest} />
        <FieldRow label="Modal spectrum" value={summary.modalSpectrum} />
        <FieldRow label="Modal branches" value={summary.modalBranches} />
        <FieldRow label="Modal dispersion" value={summary.modalDispersion} />
        <FieldRow label="Driven sweep" value={summary.drivenSweep} />
        <FieldRow label="Field payloads" value={summary.fieldPayloads} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainApiResourcesDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainApiResourceDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-api-resources-diagnostic">
      <InspectorGroup
        title="Frequency-Domain API Resource Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Manifest endpoint" value={summary.manifestEndpoint} />
        <FieldRow label="Spectrum endpoint" value={summary.spectrumEndpoint} />
        <FieldRow
          label="Eigen diagnostics endpoint"
          value={summary.eigenDiagnosticsEndpoint}
        />
        <FieldRow label="Response sweep endpoint" value={summary.responseEndpoint} />
        <FieldRow
          label="Response progress endpoint"
          value={summary.progressEndpoint}
        />
        <FieldRow label="Field endpoint" value={summary.fieldEndpoint} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainVisualizationDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainVisualizationDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-visualization-diagnostic">
      <InspectorGroup
        title="Frequency-Domain Visualization Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Mode fields" value={summary.modeOverlays} />
        <FieldRow label="Response fields" value={summary.responseOverlays} />
        <FieldRow label="Chart readiness" value={summary.chartReadiness} />
        <FieldRow label="Animation" value={summary.animation} />
        <FieldRow label="Viewport handoff" value={summary.viewportHandoff} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainPeriodicPairsResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainPeriodicPairsSummary();

  return (
    <div data-inspector-surface="frequency-domain-periodic-pairs-resource">
      <InspectorGroup
        title="Periodic/Floquet Pair Resource"
        badge={summary.badge}
      >
        <FieldRow label="Resource endpoint" value={MESHING_PERIODIC_PAIRS_PATH} />
        <FieldRow label="Pair count" value={summary.pairCount} />
        <FieldRow label="Representative pair" value={summary.representativePair} />
        <FieldRow label="Max residual" value={summary.maxResidual} />
        <FieldRow label="Invalid pairs" value={summary.invalidPairs} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainPeriodicFloquetSummary();

  return (
    <div data-inspector-surface="frequency-domain-periodic-floquet-diagnostic">
      <InspectorGroup
        title="Periodic/Floquet Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Periodic pairs" value={summary.periodicPairs} />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
        <FieldRow label="Dynamic demag-k" value={summary.dynamicDemagK} />
        <FieldRow label="Phase convention" value={summary.phaseConvention} />
        <FieldRow label="Mesh residual" value={summary.meshResidual} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainResourceFamilyInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainResourceFamilySummary();

  return (
    <div data-inspector-surface="frequency-domain-resource-family">
      <InspectorGroup title="Frequency-Domain Resource Family" badge="resources">
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Available resources" value={summary.availableResources} />
        <FieldRow label="Modal artifacts" value={summary.modalArtifacts} />
        <FieldRow label="Driven artifacts" value={summary.drivenArtifacts} />
        <FieldRow label="Field payloads" value={summary.fieldPayloads} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyDomainManifestResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainManifestResourceSummary();

  return (
    <div data-inspector-surface="frequency-domain-manifest-resource">
      <InspectorGroup
        title="Frequency-Domain Manifest Resource"
        badge={summary.schema}
      >
        <FieldRow label="Schema" value={summary.schema} />
        <FieldRow label="Resource endpoint" value={summary.resourceEndpoint} />
        <FieldRow label="Artifact" value={summary.artifact} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
        <FieldRow label="Stage kind" value={summary.stageKind} />
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

function useFmrResultSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const comparisonModel = buildFmrModalDrivenComparisonModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modalFieldCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const modalResidualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const modalDampingCount = spectrumModel.points.filter(
    (point) => point.dampingRateHz != null || point.imaginaryFrequencyHz != null,
  ).length;
  const firstModalPoint = spectrumModel.points[0] ?? null;
  const modalPeakCount = peakModel.peaks.filter(
    (peak) => peak.source === "modal",
  ).length;
  const drivenPeakCount = peakModel.peaks.filter(
    (peak) => peak.source === "driven_response",
  ).length;
  const peakFieldCount = peakModel.peaks.filter((peak) => peak.fieldId).length;
  const qualityFactorCount = peakModel.peaks.filter(
    (peak) =>
      peak.linewidthHz != null &&
      peak.linewidthHz > 0 &&
      Number.isFinite(peak.linewidthHz),
  ).length;
  const firstPeak = peakModel.peaks[0] ?? null;
  const nearestComparison = comparisonModel.nearestComparison;
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const modalReferenceCpu = capabilityStatus(modalCapabilities?.reference_cpu);
  const responseMagneticCpu = capabilityStatus(responseCapabilities?.magnetic_cpu);
  const spectrumResource = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;
  const responseResource = ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;

  return {
    activeChartRoute: `${chartRoute.mode} -> ${chartRoute.primaryChart}`,
    amplitudeUnit,
    absorbedPowerDensityUnit,
    capabilitySummary: `reference_cpu: ${modalReferenceCpu}; magnetic_cpu: ${responseMagneticCpu}`,
    comparisonPairs: comparisonModel.pairs,
    comparisonState:
      modalPeakCount > 0 && drivenPeakCount > 0
        ? "modal and driven peaks available"
        : modalPeakCount > 0
          ? "modal-only FMR"
          : drivenPeakCount > 0
            ? "driven-only FMR"
            : "no peaks available",
    detuningSummary: nearestComparison
      ? `${formatFrequency(nearestComparison.detuningHz)} driven-modal; modal ${formatFrequency(nearestComparison.modalPeak.frequencyHz)}, driven ${formatFrequency(nearestComparison.drivenPeak.frequencyHz)}`
      : comparisonModel.readiness === "modal-only"
        ? "driven response missing"
        : comparisonModel.readiness === "driven-only"
          ? "modal spectrum missing"
          : "not available",
    drivenPeakCount,
    firstPeakLabel: firstPeak
      ? `${firstPeak.source}, ${formatFrequency(firstPeak.frequencyHz)}`
      : "not available",
    modalBadge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    modalDampingCoverage: `${modalDampingCount}/${spectrumModel.points.length} mode(s)`,
    modalFieldCount,
    modalFrequencyRange: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    modalModeCount: spectrumModel.points.length,
    modalPeakCount,
    modalChartRoute: "fmr_modal -> eigen-spectrum",
    modalResidualCoverage: `${modalResidualCount}/${spectrumModel.points.length} mode(s)`,
    peakBadge: `${peakModel.peaks.length} peak(s)`,
    peakCount: peakModel.peaks.length,
    peakFieldCount,
    peaks: peakModel.peaks,
    linkedFieldHandoff: `${peakFieldCount}/${peakModel.peaks.length} peak(s) have 3D field payloads`,
    primaryModalResonance: firstModalPoint
      ? `mode ${firstModalPoint.rawModeIndex} at ${formatFrequency(firstModalPoint.frequencyHz)}`
      : "not available",
    qualityFactorCoverage: `${qualityFactorCount}/${peakModel.peaks.length} peak(s)`,
    responseBadge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    responseFieldCount,
    responseLinkedPointCount: responseModel.points.filter((point) => point.fieldId)
      .length,
    responseModel,
    responsePointCount: responseModel.points.length,
    responseResource,
    responseSeriesCount: responseModel.series.length,
    resources: `${spectrumResource}; ${responseResource}`,
    spectrumResource,
    spectrumModel,
    workflowMode: chartRoute.mode,
  };
}

function useFrequencyDomainOverviewSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modalFieldCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const frequencyValues = [
    ...spectrumModel.points.map((point) => point.frequencyHz),
    ...responseModel.points.map((point) => point.frequencyHz),
  ];

  return {
    badge: chartRoute.mode,
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    drivenVisualization: `${responseFieldCount} response field artifact(s)`,
    fmrReadiness: `${spectrumModel.points.length} modal mode(s), ${responseModel.points.length} driven point(s), ${peakModel.peaks.length} peak(s)`,
    frequencyCoverage: formatFrequencyRange(frequencyValues),
    modalVisualization: `${modalFieldCount} mode field payload(s)`,
    nextAction:
      peakModel.peaks.length > 0 || spectrumModel.points.length > 0
        ? "open FMR peaks or mode browser"
        : "run eigenmodes or frequency response stage",
    primaryWorkflow: `${chartRoute.mode} -> ${chartRoute.primaryChart}`,
    resources: `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH}; ${ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH}`,
  };
}

function useFrequencyDomainResourceFamilySummary() {
  const exportsSummary = useFrequencyDomainExportsSummary();

  return {
    availableResources:
      "modal spectrum, branches, dispersion, response sweep, progress, fields",
    drivenArtifacts: exportsSummary.drivenSweep,
    fieldPayloads: exportsSummary.fieldPayloads,
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    modalArtifacts: `${exportsSummary.modalSpectrum}; ${exportsSummary.modalBranches}`,
  };
}

function useFrequencyDomainManifestResourceSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);

  return {
    artifact: manifest.data?.result_manifest?.artifact_path ?? "not available",
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
    resourceEndpoint: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    schema: manifest.data?.schema_version ?? "not available",
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

function useEigenOverviewSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion.data,
    branchesModel,
  );
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const modalFieldCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    branches: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    dispersion: `${dispersionModel.points.length} k-path point(s), ${branchesModel.branches.length} branch(es)`,
    frequencyCoverage: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    handoff: "select mode or branch point -> plot mode field",
    spectrum: `${spectrumModel.points.length} mode(s), ${modalFieldCount} field payload(s)`,
  };
}

function useEigenStudySummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const boundaryCapabilities = record(capabilities?.boundary);
  const eigenmodes = manifest.data?.eigenmodes;
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const modeFieldCount = spectrumModel.points.filter((point) => point.modeFieldId)
    .length;

  return {
    artifacts: [
      spectrum.data?.artifact_path,
      branches.data?.artifact_path,
    ]
      .filter((item): item is string => Boolean(item))
      .join("; ") || "not available",
    badge: eigenmodes?.status ?? "missing",
    boundarySupport: `floquet_modal: ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; static_periodic: ${capabilityStatus(boundaryCapabilities?.static_periodic)}`,
    modeFields: `${modeFieldCount} mode field artifact(s)`,
    operatorLane: "linearized LLG modal operator",
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
    studyKind: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
  };
}

function useFrequencyResponseOverviewSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const responseCapabilities = record(capabilities?.response);
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancellation: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    capabilitySummary: `frequency_sweep: ${capabilityStatus(responseCapabilities?.frequency_sweep)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    frequencyCoverage: formatFrequencyRange(
      responseModel.points.map((point) => point.frequencyHz),
    ),
    handoff: "select frequency point -> plot response field",
    progress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    responseFields: `${responseFieldCount} response field artifact(s)`,
    sweep: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
  };
}

function useFrequencyResponseStudySummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );

  return {
    artifacts: responseSweep.data?.artifact_path ?? "not available",
    badge: response?.status ?? "missing",
    boundarySupport: `static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; floquet_response=${String(response?.floquet_response_available ?? false)}`,
    executionLane: responseExecutionLaneFromManifest(response),
    magnetostaticBc: requestedMagnetostaticBc(manifestPayload),
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
    spinWaveBc: formatSpinWaveBc(manifestPayload),
    studyKind: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}`,
    sweepContract: `${responseModel.points.length} solved point(s), ${responseModel.series.length} observable series`,
  };
}

function capabilityStatus(value: unknown): string {
  const status = record(value)?.status;
  return typeof status === "string" && status.trim()
    ? status
    : "not available";
}

function useFrequencyDomainRunSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const requestedExecution = record(manifestPayload?.requested_execution);
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const eigenmodes = manifest.data?.eigenmodes;
  const responseStudyKind = response?.study_kind ?? "frequency_response";
  const eigenStudyKind = eigenmodes?.study_kind ?? "eigenmodes";

  return {
    badge:
      manifest.status === "ready"
        ? (manifest.data?.schema_version ?? "ready")
        : manifest.status,
    calculationMode:
      stringValue(requestedExecution?.calculation_mode) ?? "not available",
    eigenLane: `${eigenStudyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    eigenNamespace: manifest.data?.eigen_namespace ?? "not available",
    familyNamespace: manifest.data?.family_namespace ?? "not available",
    manifestArtifact:
      manifest.data?.result_manifest?.artifact_path ?? "not available",
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    namespaceCompatibility: `existing frequency_response namespace preserved=${String(
      manifest.data?.existing_frequency_response_namespace_preserved ?? false,
    )}`,
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
      stringValue(physics?.field_units) ?? "not available",
    ].join("; "),
    responseLane: `${responseStudyKind}: ${response?.status ?? "missing"}; driven=${String(
      response?.driven_response_available ?? false,
    )}; static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; gpu=${String(response?.gpu_available ?? false)}`,
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

function useFmrComparisonSummary() {
  const summary = useFmrResultSummary();
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const comparisonModel = buildFmrModalDrivenComparisonModel({
    manifestPayload: frequencyDomainManifestPayload(manifest.data),
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const nearestComparison = comparisonModel.nearestComparison;
  const modalPeak = nearestComparison?.modalPeak ?? null;
  const drivenPeak = nearestComparison?.drivenPeak ?? null;
  const frequencyOffset = nearestComparison?.detuningHz ?? null;
  const amplitudeRatio =
    modalPeak?.amplitude != null &&
    drivenPeak?.amplitude != null &&
    modalPeak.amplitude !== 0
      ? drivenPeak.amplitude / modalPeak.amplitude
      : null;

  return {
    actionBadge:
      modalPeak?.fieldId && drivenPeak?.fieldId
        ? "both fields ready"
        : modalPeak?.fieldId
          ? "modal field ready"
          : drivenPeak?.fieldId
            ? "driven field ready"
            : "fields missing",
    amplitudeRatio:
      amplitudeRatio == null
        ? "not available"
        : `${formatNumber(amplitudeRatio)} driven/modal`,
    badge:
      modalPeak && drivenPeak
        ? "ready"
        : modalPeak
          ? "modal-only"
          : drivenPeak
            ? "driven-only"
            : "missing peaks",
    drivenOverlay: drivenPeak?.fieldId
      ? `${drivenPeak.fieldId}; response field ready`
      : drivenPeak
        ? "driven peak field missing"
        : "no driven peak selected",
    drivenActionTarget: drivenPeak
      ? `driven response ${formatFrequency(drivenPeak.frequencyHz)}`
      : "not available",
    drivenPeakPoint: drivenPeak,
    drivenPeak: drivenPeak
      ? `${formatFrequency(drivenPeak.frequencyHz)}; amplitude ${formatNumberOrUnavailable(drivenPeak.amplitude)}`
      : "not available",
    frequencyOffset:
      frequencyOffset == null
        ? "not available"
        : `${formatNumber(frequencyOffset)} Hz (${formatFrequency(frequencyOffset)})`,
    modalOverlay: modalPeak?.fieldId
      ? `${modalPeak.fieldId}; mode field ready`
      : `${summary.modalFieldCount} mode field artifact(s)`,
    modalActionTarget: modalPeak
      ? `modal mode ${modalPeak.modeRef?.rawModeIndex ?? "?"} ${formatFrequency(modalPeak.frequencyHz)}`
      : "not available",
    modalPeakPoint: modalPeak,
    modalResonance: modalPeak
      ? `${formatFrequency(modalPeak.frequencyHz)}; mode ${
          modalPeak.modeRef?.rawModeIndex ?? "?"
        }`
      : "not available",
    pairs: comparisonModel.pairs,
    readiness: summary.comparisonState,
    resources: `${summary.spectrumResource}; ${summary.responseResource}`,
    validationState: modalPeak && drivenPeak
      ? `${modalPeak.validationStatus} modal, ${drivenPeak.validationStatus} driven`
      : "requires both modal and driven peaks",
    spatialOverlap: nearestComparison?.drivenPeak?.overlap != null
      ? formatNumber(nearestComparison.drivenPeak.overlap)
      : (!modalPeak?.fieldId || !drivenPeak?.fieldId
          ? "degraded (field payload missing; request link)"
          : "degraded (field payload missing; request link)"),
  };
}

function useFrequencyDomainProvenanceSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const requestedExecution = record(manifestPayload?.requested_execution);
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const eigenmodes = manifest.data?.eigenmodes;
  const responseStudyKind = response?.study_kind ?? "frequency_response";
  const eigenStudyKind = eigenmodes?.study_kind ?? "eigenmodes";
  const responseFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const modeFieldCount = spectrumModel.points.filter((point) => point.modeFieldId)
    .length;

  return {
    branchArtifact: branches.data?.artifact_path ?? "not available",
    calculationMode:
      stringValue(requestedExecution?.calculation_mode) ?? "not available",
    cancelArtifact:
      cancelRequested.data?.latest_artifact_manifest_path ?? "not available",
    eigenLane: `${eigenStudyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    manifestArtifact:
      manifest.data?.result_manifest?.artifact_path ?? "not available",
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    magnetostaticBc: requestedMagnetostaticBc(manifestPayload),
    modalSpectrumArtifact: spectrum.data?.artifact_path ?? "not available",
    modeFieldArtifacts: `${modeFieldCount} mode field artifact(s)`,
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
      stringValue(physics?.field_units) ?? "not available",
    ].join("; "),
    responseFieldArtifacts: `${responseFieldCount} field artifact(s)`,
    responseLane: `${responseStudyKind}: ${response?.status ?? "missing"}; driven=${String(
      response?.driven_response_available ?? false,
    )}; static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; gpu=${String(response?.gpu_available ?? false)}`,
    responseSweepArtifact: responseSweep.data?.artifact_path ?? "not available",
    spinWaveBc: formatSpinWaveBc(manifestPayload),
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

function useFrequencyDomainDispersionSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion.data,
    branchesModel,
  );
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const boundaryCapabilities = record(capabilities?.boundary);
  const frequencies = dispersionModel.points.map((point) => point.frequencyHz);
  const pathValues = dispersionModel.points.map((point) => point.pathS);
  const analyticReference = dispersionAnalyticReferenceSummary(
    dispersionModel.points,
  );
  const validationIntent =
    dispersionValidationIntentSummary(manifestPayload);
  const primaryBranch = branchesModel.branches[0] ?? null;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const pathMetadata = dispersionPathMetadataSummary(
    dispersion.data?.path_metadata,
  );

  return {
    badge:
      dispersion.status === "ready"
        ? `${dispersionModel.points.length} point(s)`
        : dispersion.status,
    branchCount: branchesModel.branches.length,
    analyticReference,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    branchesModel,
    dispersionPointCount: dispersionModel.points.length,
    dispersionModel,
    dispersionResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    dispersionSeriesCount: dispersionModel.series.length,
    floquetGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    frequencyRange: formatFrequencyRange(frequencies),
    kPathSpan: `${formatNumberRange(pathValues)} rad/m`,
    modalOverlays: `${spectrumModel.points.filter((point) => point.modeFieldId).length} mode field(s) available from modal spectrum`,
    pathLabels: pathMetadata.labels,
    pathMetadataArtifact: pathMetadata.artifact,
    pathSampling: pathMetadata.sampling,
    primaryBranch: primaryBranch
      ? `${primaryBranch.label ?? primaryBranch.branchId}; ${formatFrequencyRange(
          primaryBranch.points.map((point) => point.frequencyRealHz),
        )}`
      : "not available",
    trackedPointCount,
    validationIntent,
  };
}

function dispersionAnalyticReferenceSummary(
  points: readonly EigenDispersionPoint[],
): string {
  const analyticPoints = points.filter(
    (point) => point.analyticFrequencyHz != null,
  );
  if (analyticPoints.length === 0) return "not available";
  const geometries = [
    ...new Set(
      analyticPoints.flatMap((point) =>
        point.validationGeometry == null ? [] : [point.validationGeometry],
      ),
    ),
  ].sort();
  const relativeErrors = analyticPoints.flatMap((point) =>
    point.relativeError == null ? [] : [point.relativeError],
  );
  const maxRelativeError = maxFinite(relativeErrors);
  const geometrySummary = geometries.length > 0 ? geometries.join(", ") : "unlabelled";
  const errorSummary =
    maxRelativeError == null
      ? "max error not available"
      : `max rel. error ${formatNumber(maxRelativeError)}`;
  return `${analyticPoints.length} point(s); ${geometrySummary}; ${errorSummary}`;
}

function dispersionValidationIntentSummary(
  manifestPayload: Record<string, unknown> | null,
): string {
  const validation = record(manifestPayload?.validation);
  const dispersionValidation = record(validation?.dispersion_validation);
  if (!dispersionValidation) return "not available";
  const kind = stringValue(dispersionValidation.kind) ?? "unknown";
  const analyticModel =
    stringValue(dispersionValidation.analytic_model) ?? "unknown";
  const maxK = finiteNumber(dispersionValidation.max_k_rad_per_m);
  const frequencyWindow = record(dispersionValidation.frequency_window_hz);
  const frequencyMin = finiteNumber(frequencyWindow?.min);
  const frequencyMax = finiteNumber(frequencyWindow?.max);
  const scenarios = Array.isArray(dispersionValidation.scenarios)
    ? dispersionValidation.scenarios
    : [];
  const scenarioSummary = scenarios
    .flatMap((scenario) => {
      const scenarioRecord = record(scenario);
      if (!scenarioRecord) return [];
      const geometry = stringValue(scenarioRecord.geometry) ?? "unknown";
      const branchId = stringValue(scenarioRecord.branch_id) ?? "unlabelled";
      const sampleIndices = Array.isArray(scenarioRecord.sample_indices)
        ? scenarioRecord.sample_indices.length
        : 0;
      return [`${geometry}: ${branchId} [${sampleIndices} sample(s)]`];
    })
    .sort()
    .join(", ");
  const maxKSummary =
    maxK == null
      ? "k<=not available"
      : `k<=${formatWaveVectorLimit(maxK)} rad/m`;
  const frequencySummary =
    frequencyMin == null || frequencyMax == null
      ? "frequency window not available"
      : formatValidationFrequencyWindow(frequencyMin, frequencyMax);
  return [
    kind,
    analyticModel,
    maxKSummary,
    frequencySummary,
    scenarioSummary || "scenarios not available",
  ].join("; ");
}

function formatWaveVectorLimit(value: number): string {
  return value >= 1.0e5 ? value.toExponential(3) : formatNumber(value);
}

function formatValidationFrequencyWindow(minHz: number, maxHz: number): string {
  if (minHz === 0) return `0-${formatFrequency(maxHz)}`;
  return `${formatFrequency(minHz)}-${formatFrequency(maxHz)}`;
}

function dispersionPathMetadataSummary(pathMetadata: unknown): {
  artifact: string;
  labels: string;
  sampling: string;
} {
  const metadata = record(pathMetadata);
  const sampling = record(metadata?.sampling);
  if (!sampling) {
    return {
      artifact: "not available",
      labels: "not available",
      sampling: "not available",
    };
  }

  const points = Array.isArray(sampling.points) ? sampling.points : [];
  const labels = points
    .map((point) => stringValue(record(point)?.label))
    .filter((label): label is string => Boolean(label));
  const samplesPerSegment = Array.isArray(sampling.samples_per_segment)
    ? sampling.samples_per_segment
        .map((sample) => finiteNumber(sample))
        .filter((sample): sample is number => sample != null)
    : [];
  const segmentCount =
    samplesPerSegment.length > 0
      ? samplesPerSegment.length
      : Math.max(0, points.length - 1);
  const sampleCount =
    samplesPerSegment.length > 0
      ? samplesPerSegment.reduce((sum, sample) => sum + sample, 1)
      : null;
  const kind = stringValue(sampling.kind) ?? "path";
  const closure = sampling.closed === true ? "closed" : "open";

  return {
    artifact: "eigen/dispersion/path.json",
    labels: labels.length > 0 ? labels.join(" -> ") : "not available",
    sampling: `${kind}; ${segmentCount} segment(s), ${formatNullableNumber(sampleCount)} sample(s), ${closure}`,
  };
}

function useEigenDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const eigenDiagnostics = useFrequencyDomainEigenDiagnosticsResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion.data,
    branchesModel,
  );
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const boundaryCapabilities = record(capabilities?.boundary);
  const eigenmodes = manifest.data?.eigenmodes;
  const studyKind = eigenmodes?.study_kind ?? "eigenmodes";
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const residualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const fieldOverlayCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const modalDiagnostics = eigenDiagnosticTransportSummary(eigenDiagnostics.data);

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    branchDiagnostics: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    demagKGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    dispersionSamples: `${dispersionModel.points.length} point(s), ${dispersion.status}`,
    floquetTransport: modalDiagnostics.transport,
    modalAvailability: `${studyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    modalSpectrum: `${spectrumModel.points.length} mode(s), ${fieldOverlayCount} field payload(s)`,
    residualCoverage: `${residualCount}/${spectrumModel.points.length} mode(s)`,
    solverModel: modalDiagnostics.solverModel,
  };
}

function dispersionCapabilitySummary(
  dispersionCapabilities: Record<string, unknown> | null,
): string {
  return [
    `reference_cpu: ${capabilityStatus(dispersionCapabilities?.reference_cpu)}`,
    `production_cpu: ${capabilityStatus(dispersionCapabilities?.production_cpu)}`,
    `production_cpu_gamma_k_path: ${capabilityStatus(dispersionCapabilities?.production_cpu_gamma_k_path)}`,
    `production_gpu: ${capabilityStatus(dispersionCapabilities?.production_gpu)}`,
    `k_path: ${capabilityStatus(dispersionCapabilities?.k_path)}`,
    `branch_tracking: ${capabilityStatus(dispersionCapabilities?.branch_tracking)}`,
  ].join("; ");
}

function frequencyDomainRuntimeCapabilities(
  manifest: unknown,
): Record<string, unknown> | null {
  const manifestRecord = record(manifest);
  const resultManifest = record(manifestRecord?.result_manifest);
  const payload = record(resultManifest?.payload);
  const manifestCapabilities = record(manifestRecord?.capabilities);
  const runtimeCapabilities = record(payload?.capabilities);

  if (manifestCapabilities && runtimeCapabilities) {
    return { ...manifestCapabilities, ...runtimeCapabilities };
  }

  return runtimeCapabilities ?? manifestCapabilities;
}

function useEigenBranchesSummary() {
  const branches = useFrequencyDomainEigenBranchesResource();
  const branchesModel = buildEigenBranchesModel(branches.data);
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const primaryBranch = branchesModel.branches[0] ?? null;
  const allFrequencies = branchesModel.branches.flatMap((branch) =>
    branch.points.map((point) => point.frequencyRealHz),
  );
  const sampleValues = branchesModel.branches.flatMap((branch) =>
    branch.points.map((point) => point.sampleIndex),
  );
  const representativePoint = primaryBranch?.points[0] ?? null;

  return {
    badge:
      branches.status === "ready"
        ? `${branchesModel.branches.length} branch(es)`
        : branches.status,
    branchCount: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    branchGaps: primaryBranch
      ? `${primaryBranch.sampleGapCount ?? 0} gap(s); max gap ${primaryBranch.sampleGapMax ?? 0}`
      : "not available",
    branchResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    branchWarnings:
      primaryBranch?.warnings && primaryBranch.warnings.length > 0
        ? primaryBranch.warnings.join("; ")
        : "none",
    frequencyCoverage: formatFrequencyRange(allFrequencies),
    overlapQuality: primaryBranch
      ? `mean overlap ${formatCompactNumberOrUnavailable(primaryBranch.overlapPrevMean)}; lowest overlap ${formatCompactNumberOrUnavailable(primaryBranch.overlapPrevMin)}; min confidence ${formatCompactNumberOrUnavailable(primaryBranch.trackingConfidenceMin)}`
      : "not available",
    primaryBranch: primaryBranch
      ? `${primaryBranch.label ?? primaryBranch.branchId}; ${formatFrequencyRange(
          primaryBranch.points.map((point) => point.frequencyRealHz),
        )}`
      : "not available",
    representativeMode: representativePoint
      ? `sample ${representativePoint.sampleIndex}, mode ${representativePoint.rawModeIndex}, ${formatFrequency(representativePoint.frequencyRealHz)}`
      : "not available",
    sampleCoverage: sampleValues.length
      ? `sample ${Math.min(...sampleValues)}-${Math.max(...sampleValues)}`
      : "not available",
  };
}

function useEigenSpectrumSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const frequencies = spectrumModel.points.map((point) => point.frequencyHz);
  const dampingCount = spectrumModel.points.filter(
    (point) => point.dampingRateHz != null || point.imaginaryFrequencyHz != null,
  ).length;
  const residualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const fieldOverlayCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const primaryMode = spectrumModel.points[0] ?? null;
  const payload = record(spectrum.data?.payload);
  const candidate = record(payload?.candidate_identity);
  const solveSucceeded =
    typeof payload?.solve_succeeded === "boolean"
      ? payload.solve_succeeded
      : null;
  const fieldsAvailable =
    typeof payload?.fields_available === "boolean"
      ? payload.fields_available
      : null;
  const windowComplete =
    typeof payload?.window_complete === "boolean"
      ? payload.window_complete
      : null;
  const identityParts = [
    spectrum.data?.run_id ? `run=${spectrum.data.run_id}` : null,
    spectrum.data?.stage_id ? `stage=${spectrum.data.stage_id}` : null,
    spectrum.data?.revision ? `artifact=${spectrum.data.revision}` : null,
    spectrum.data?.mesh_generation_id
      ? `mesh=${spectrum.data.mesh_generation_id}`
      : stringValue(candidate?.mesh_generation_id)
        ? `mesh=${stringValue(candidate?.mesh_generation_id)}`
        : null,
    stringValue(candidate?.device)
      ? `device=${stringValue(candidate?.device)}`
      : null,
  ].filter((value): value is string => value != null);

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; mode_field_payload: ${capabilityStatus(modalCapabilities?.mode_field_payload)}`,
    dampingCoverage: `${dampingCount}/${spectrumModel.points.length} mode(s)`,
    candidateIdentity:
      identityParts.length > 0 ? identityParts.join("; ") : "not published",
    fieldAvailability:
      fieldsAvailable == null
        ? "unknown"
        : fieldsAvailable
          ? "available"
          : "unavailable",
    fieldOverlayCount,
    frequencyRange: formatFrequencyRange(frequencies),
    modeCount: spectrumModel.points.length,
    primaryMode: primaryMode
      ? `mode ${primaryMode.rawModeIndex} at ${formatFrequency(primaryMode.frequencyHz)}`
      : "not available",
    residualCoverage: `${residualCount}/${spectrumModel.points.length} mode(s)`,
    solveStatus:
      solveSucceeded == null
        ? "unknown"
        : solveSucceeded
          ? "succeeded"
          : "failed",
    spectrumCompleteness:
      stringValue(payload?.spectrum_completeness) ?? "unknown",
    spectrumModel,
    spectrumResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    windowCertificate:
      windowComplete == null
        ? "unknown"
        : windowComplete
          ? "complete"
          : "incomplete",
  };
}

export function responseMapAvailabilityFromTypedResource(
  resource: unknown,
): "ready" | "loading" | "stale" | "error" | "unsupported" {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return "unsupported";
  }

  const candidate = resource as { data?: unknown; status?: unknown };
  if (candidate.status === "ready" && candidate.data != null) {
    return "ready";
  }
  if (
    candidate.status === "loading" ||
    candidate.status === "stale" ||
    candidate.status === "error"
  ) {
    return candidate.status;
  }
  return "unsupported";
}

function useFrequencyDomainResponseMapSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const demagCapabilities = record(capabilities?.demag);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const modeRows = buildFrequencyDomainCalculationModeRows(
    manifest.data?.capabilities,
    manifest.data?.floquet_nonzero_k_response_supported,
  );
  const responseMapRow = modeRows.find((row) => row.mode === "response_map");
  const spinWaveBc = record(manifestPayload?.spin_wave_bc);
  const kVector = Array.isArray(spinWaveBc?.floquet_k_vector_rad_per_m)
    ? spinWaveBc.floquet_k_vector_rad_per_m.flatMap((value) => {
        const parsed = finiteNumber(value);
        return parsed == null ? [] : [parsed];
      })
    : [];
  const fieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  // The capability bit describes a legal execution lane, not a published
  // k-by-f response resource. Until that typed resource is exposed, keep the
  // result unavailable and fall back to the verified FMR response sweep.
  const responseMapAvailability =
    responseMapAvailabilityFromTypedResource(null);

  return {
    availability: responseMapAvailability,
    badge: responseMapAvailability,
    blockingPhysics: `dynamic_demag_k: ${capabilityStatus(demagCapabilities?.floquet_dynamic_k)}`,
    capabilityGate: responseMapRow?.capabilityStatus ?? "not available",
    currentResponseEvidence: `${responseModel.points.length} point(s), ${fieldCount} response field(s)`,
    floquetRequest:
      spinWaveBc && stringValue(spinWaveBc.kind)
        ? `kind=${stringValue(spinWaveBc.kind)}; k=[${kVector
            .map(formatNumber)
            .join(", ")}] rad/m`
        : "not requested",
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    uiFallback:
      responseMapAvailability === "ready"
        ? "show response map controls"
        : "Typed response-map resource is not published; show FMR response sweep until nonzero-k map is executable",
  };
}

function useEigenModesSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const visualizationCapabilities = record(capabilities?.visualization);
  const modeCount = spectrumModel.points.length;
  const overlayReadyCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const firstSelectableMode =
    spectrumModel.points.find((point) => point.modeFieldId) ??
    spectrumModel.points[0] ??
    null;

  return {
    badge: spectrum.status === "ready" ? `${modeCount} mode(s)` : spectrum.status,
    capabilitySummary: `mode_table: ${capabilityStatus(visualizationCapabilities?.mode_table)}; mode_3d_overlay: ${capabilityStatus(visualizationCapabilities?.mode_3d_overlay)}`,
    firstSelectableMode: firstSelectableMode
      ? `sample ${firstSelectableMode.sampleIndex}, mode ${firstSelectableMode.rawModeIndex}, ${formatFrequency(firstSelectableMode.frequencyHz)}`
      : "not available",
    frequencyRange: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    modeTable: `${modeCount} mode(s), ${overlayReadyCount} field-ready`,
    modeTableResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    spectrumModel,
  };
}

function useFrequencyDomainExportsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modalFieldCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const readyArtifacts = [
    manifest.data?.result_manifest?.artifact_path,
    spectrum.data?.artifact_path,
    branches.data?.artifact_path,
    responseSweep.data?.artifact_path,
    dispersion.status === "ready" ? "eigen/dispersion.csv" : null,
  ].filter((item): item is string => Boolean(item));

  return {
    apiResources: [
      ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    ].join("; "),
    badge: readyArtifacts.length ? `${readyArtifacts.length} artifact(s)` : "missing",
    bundle: "manifest + modal artifacts + driven response artifacts",
    drivenSweep:
      responseSweep.data?.artifact_path ??
      (responseSweep.status === "ready" ? "response/magnetic_response_sweep.v2.json" : "not available"),
    exportFormats: "JSON control plane, CSV dispersion, Zarr field payloads",
    fieldPayloads: `${responseFieldCount} response field(s), ${modalFieldCount} modal field(s)`,
    manifest:
      manifest.data?.result_manifest?.artifact_path ??
      "frequency_domain/manifest.v1.json",
    modalBranches: branches.data?.artifact_path ?? "not available",
    modalDispersion:
      dispersion.status === "ready" ? "eigen/dispersion.csv" : "not available",
    modalSpectrum: spectrum.data?.artifact_path ?? "not available",
    pythonRoundTrip: "canonical Eigenmodes / FrequencyResponse studies",
  };
}

function useCalculationModesSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const modeRows = buildFrequencyDomainCalculationModeRows(
    manifest.data?.capabilities,
    manifest.data?.floquet_nonzero_k_response_supported,
  );
  const activeRow =
    modeRows.find((row) => row.mode === chartRoute.mode) ?? modeRows[0]!;
  const modalRows = modeRows.filter(
    (row) => row.canonicalStudy === "Eigenmodes",
  );
  const drivenRows = modeRows.filter(
    (row) => row.canonicalStudy === "FrequencyResponse",
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const responseMapRow = modeRows.find((row) => row.mode === "response_map");

  return {
    activeMode: chartRoute.mode,
    activeStudy: activeRow.canonicalStudy,
    activeWorkflow: `${chartRoute.mode}; ${chartRoute.status}${
      chartRoute.unavailableReason ? ` (${chartRoute.unavailableReason})` : ""
    }`,
    capabilityRoute: activeRow.capabilityStatus,
    drivenEvidence:
      responseModel.points.length > 0
        ? `${responseModel.points.length} response point(s), ${responseModel.series.length} observable series`
        : "no driven response sweep loaded",
    drivenWorkflows: drivenRows.map((row) => row.mode).join(", "),
    modalEvidence:
      spectrumModel.points.length > 0
        ? `${spectrumModel.points.length} mode(s), ${
            spectrumModel.points.filter((point) => point.modeFieldId).length
          } field-ready`
        : "no modal spectrum loaded",
    modalWorkflows: modalRows.map((row) => row.mode).join(", "),
    modeRows,
    primaryChart: chartRoute.primaryChart,
    requiredArtifacts: activeRow.artifacts,
    responseMapGate: responseMapRow?.capabilityStatus ?? "not available",
  };
}

function useFmrPeakSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const peakIndex = ref?.fmrPeakIndex ?? null;
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = frequencyDomainManifestPayload(manifest.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const peak = peakIndex == null ? null : peakModel.peaks[peakIndex] ?? null;
  const source = peak?.source ?? null;
  const isModal = source === "modal";
  const modeRef = peak?.modeRef ?? null;
  const frequencyPointIndex = peak?.frequencyPointIndex ?? null;
  const fieldResource = peak?.fieldResourceKey ?? null;
  const sourceResource = isModal
    ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH
    : ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;
  const resource =
    ref?.resourceRef ??
    fieldResource ??
    sourceResource;
  const sourceInspectorKind = isModal
    ? "results.frequency_domain.fmr_modal_spectrum"
    : "results.frequency_domain.fmr_response_sweep";
  const sourceInspectorLabel = isModal
    ? "FMR Modal Spectrum"
    : "FMR Response Sweep";
  const sourceInspectorNodeId = isModal
    ? "results:frequency-domain:fmr:modal-spectrum"
    : "results:frequency-domain:fmr:response-sweep";
  const amplitudeUnit =
    peak?.amplitudeUnit ?? frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit =
    peak?.absorbedPowerDensityUnit ??
    frequencyResponseSeriesUnit(responseModel, "absorbed-power-density");

  return {
    absorbedPowerDensity:
      peak?.absorbedPowerDensity == null
        ? "not available"
        : formatQuantity(peak.absorbedPowerDensity, absorbedPowerDensityUnit),
    amplitude: formatQuantity(peak?.amplitude, amplitudeUnit),
    actionBadge: peak?.fieldId ? "3D-ready" : "metadata",
    artifactFamily: isModal ? "eigen/spectrum.v2.json" : "response/magnetic-sweep",
    badge:
      peakIndex == null
        ? "unselected"
        : peak
          ? `peak ${peakIndex + 1}`
          : "missing",
    fieldId: peak?.fieldId ?? null,
    fieldPayload: peak?.fieldId ? `${peak.fieldId}; field-ready` : "missing",
    dataPlaneResource: fieldResource ?? resource ?? "not available",
    frequency: formatFrequency(peak?.frequencyHz),
    frequencyPointIndex,
    hasLinkedTarget: Boolean(modeRef || frequencyPointIndex != null),
    interpretation: isModal
      ? "modal resonance from the eigen spectrum"
      : source === "driven_response"
        ? "driven-response peak from the FMR sweep"
        : "peak metadata is unavailable",
    linewidth: formatFrequency(peak?.linewidthHz),
    missingSpectralValues: missingValueSummary([
      ["amplitude", peak?.amplitude],
      ["absorbed power", peak?.absorbedPowerDensity],
      ["phase", peak?.phaseRad],
      ["linewidth", peak?.linewidthHz],
    ]),
    modeRef,
    phase: peak?.phaseRad == null ? "not available" : `${formatNumber(peak.phaseRad)} rad`,
    provenanceBadge: peak?.fieldId ? "field-linked" : "metadata",
    resource,
    source:
      source === "modal"
        ? "modal eigenmode"
        : source === "driven_response"
          ? "driven response"
          : "not available",
    sourceBadge:
      source === "modal"
        ? "modal"
        : source === "driven_response"
          ? "driven"
          : "missing",
    sourceInspectorKind,
    sourceInspectorLabel,
    sourceInspectorNodeId,
    sourceResource,
    spectralBadge:
      peak == null
        ? "missing"
        : [peak.amplitude, peak.absorbedPowerDensity, peak.phaseRad, peak.linewidthHz].some(
              (value) => value != null,
            )
          ? "partial"
          : "metadata-only",
    target: isModal
      ? modeRef
        ? `sample ${modeRef.sampleIndex}, mode ${modeRef.rawModeIndex}`
        : "mode not available"
      : frequencyPointIndex == null
        ? "frequency point not available"
        : `frequency point ${frequencyPointIndex}`,
    validation: peak?.validationStatus ?? "not available",
    visualizationReadiness: peak?.fieldId
      ? "field id is published; plot command can use the linked field id"
      : "field payload missing; 3D field is unavailable",
  };
}

function useFrequencyResponsePointSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const frequencyIndex = ref?.frequencyIndex ?? null;
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const frequencyPoint =
    useFrequencyDomainResponseFrequencyPointResource(frequencyIndex);
  const fieldMeta = useFrequencyDomainResponseFieldMetaResource(frequencyIndex);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const matchingPoints = responseModel.points.filter(
    (point) => point.frequencyIndex === frequencyIndex,
  );
  const firstPoint = matchingPoints[0] ?? null;
  const payload = record(frequencyPoint.data?.payload);
  const frequencyHz =
    finiteNumber(payload?.frequency_hz) ?? firstPoint?.frequencyHz ?? null;
  const amplitude =
    finiteNumber(payload?.response_amplitude) ??
    finiteNumber(payload?.amplitude) ??
    firstPoint?.amplitude ??
    null;
  const phase =
    finiteNumber(payload?.response_phase) ??
    finiteNumber(payload?.phase_rad) ??
    firstPoint?.phaseRad ??
    null;
  const absorbedPowerDensity =
    finiteNumber(payload?.absorbed_power_density) ??
    firstPoint?.absorbedPowerDensity ??
    null;
  const residual =
    finiteNumber(payload?.relative_residual_l2_norm) ??
    finiteNumber(payload?.relative_residual_norm) ??
    finiteNumber(payload?.residual_l2_norm) ??
    firstPoint?.residualNorm ??
    null;
  const fieldId =
    ref?.fieldId ?? fieldMeta.data?.field_id ?? firstPoint?.fieldId ?? null;
  const fieldResource = ref?.resourceRef ?? fieldMeta.data?.resource_key ?? null;
  const availableViews = fieldMeta.data?.available_views ?? [];
  const defaultView = fieldMeta.data?.default_view ?? availableViews[0] ?? null;
  const defaultPhaseRad =
    finiteNumber(fieldMeta.data?.default_phase_rad) ?? firstPoint?.phaseRad ?? 0;
  const absorptionProvenance = record(payload?.absorbed_power_density_provenance);
  const susceptibilityProvenance = record(payload?.susceptibility_tensor_provenance);
  const provenance = [
    stringValue(absorptionProvenance?.kind),
    stringValue(susceptibilityProvenance?.kind),
  ]
    .filter((item): item is string => item != null)
    .join("; ");

  const field3DReady =
    fieldMeta.status === "ready" && canPlotSelectedFieldIn3D(fieldMeta.data);
  const field3DStatus =
    fieldMeta.status === "ready"
      ? selectedField3DPlotStatus(fieldMeta.data)
      : fieldMeta.status === "loading"
        ? "response field metadata loading"
        : fieldMeta.status === "error"
          ? "response field metadata unavailable"
          : "response field metadata not available";

  return {
    actionBadge: field3DReady ? "3D field ready" : "3D unavailable",
    absorbedPowerDensity:
      absorbedPowerDensity == null
        ? "not available"
        : formatQuantity(absorbedPowerDensity, absorbedPowerDensityUnit),
    amplitude: formatQuantity(amplitude, amplitudeUnit),
    amplitudeUnit,
    artifactPath: frequencyPoint.data?.artifact_path ?? "not available",
    availableViews: availableViews.length ? availableViews.join(", ") : "not available",
    availableViewValues: normalizedAnalysisFieldViewOptions(
      availableViews,
      defaultView,
    ),
    badge:
      frequencyIndex == null
        ? "unselected"
        : frequencyPoint.status === "ready"
          ? `frequency ${frequencyIndex}`
          : frequencyPoint.status,
    componentBasis: fieldMeta.data?.component_basis ?? null,
    componentCount: finiteNumber(fieldMeta.data?.component_count),
    componentOptions:
      fieldMeta.status === "ready"
        ? modeFieldComponentOptions(fieldMeta.data)
        : [],
    defaultPhaseLabel: `${formatNumber(defaultPhaseRad)} rad`,
    defaultPhaseRad,
    defaultView: normalizeAnalysisFieldView(defaultView),
    defaultViewLabel: defaultView ? analysisFieldViewLabel(defaultView) : "not available",
    fieldId,
    fieldIdLabel: fieldId ?? "not available",
    fieldResource: fieldResource ?? "not available",
    field3DReady,
    fieldStatus: fieldId
      ? `${fieldId}; ${field3DStatus}`
      : "field artifact missing",
    field3DStatus,
    frequencyDisplay: formatFrequency(frequencyHz),
    frequencyIndex,
    absorbedPowerDensityUnit,
    observableRows: `${matchingPoints.length} sweep row(s)`,
    phase: phase == null ? "not available" : `${formatNumber(phase)} rad`,
    provenance: provenance || "not available",
    residual: formatNumberOrUnavailable(residual),
    resourceKey:
      frequencyIndex == null
        ? "not available"
        : ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
            "{frequency_index}",
            String(frequencyIndex),
          ),
    valueKind: fieldMeta.data?.value_kind ?? null,
  };
}

function missingValueSummary(
  values: readonly [label: string, value: number | null | undefined][],
): string {
  const missing = values.flatMap(([label, value]) =>
    value == null ? [label] : [],
  );
  return missing.length ? missing.join(", ") : "none";
}

function useFrequencyResponseFrequencyPointsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const frequencies = responseModel.points.map((point) => point.frequencyHz);
  const amplitudes = responseModel.points.flatMap((point) =>
    point.amplitude == null ? [] : [point.amplitude],
  );
  const residuals = responseModel.points.flatMap((point) =>
    point.residualNorm == null ? [] : [point.residualNorm],
  );
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;

  return {
    amplitudeRange: formatNumberRange(amplitudes, ` ${amplitudeUnit}`),
    amplitudeUnit,
    absorbedPowerDensityUnit,
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancellationState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    fieldOverlays: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    frequencyRange: formatFrequencyRange(frequencies),
    progressState: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    residualCoverage: `${residuals.length}/${responseModel.points.length} point(s)`,
    resourceKey:
      responseSweep.data?.resource_key ??
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    responseModel,
    solvedFrequencies: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
    workflow: "select frequency point -> inspect response field payload in 3D",
  };
}

function useFrequencyResponseProgressSummary() {
  const progress = useFrequencyDomainResponseProgressResource();
  const data = progress.data;

  return frequencyResponseSweepStatusSummary({
    data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    status: progress.status,
  });
}

function useFrequencyResponseCancelRequestedSummary() {
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const data = cancelRequested.data;

  return frequencyResponseSweepStatusSummary({
    data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    status: cancelRequested.status,
  });
}

function useFrequencyResponseObservableSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const observableId = ref?.observableId ?? selection.label ?? null;
  const points = responseModel.points.filter(
    (point) => point.observableId === observableId,
  );
  const frequencies = points.map((point) => point.frequencyHz);
  const amplitudes = points.flatMap((point) =>
    point.amplitude == null ? [] : [point.amplitude],
  );
  const phases = points.flatMap((point) =>
    point.phaseRad == null ? [] : [point.phaseRad],
  );
  const absorbedPowers = points.flatMap((point) =>
    point.absorbedPowerDensity == null ? [] : [point.absorbedPowerDensity],
  );
  const fieldOverlayCount = points.filter((point) => point.fieldId).length;
  const chartSeries = responseModel.series.filter(
    (series) => series.quantity === observableId || series.id.includes(String(observableId)),
  );

  return {
    badge:
      observableId == null
        ? "unselected"
        : responseSweep.status === "ready"
          ? `${points.length} point(s)`
          : responseSweep.status,
    chartSeriesStatus: chartSeries.length
      ? `${chartSeries.length} series, ${chartSeries.map((series) => series.label).join(", ")}`
      : "not available",
    fieldOverlayStatus: `${fieldOverlayCount}/${points.length} point(s) field-ready`,
    frequencyRange: formatFrequencyRange(frequencies),
    maxAbsorbedPowerDensity: maxFinite(absorbedPowers) == null
      ? "not available"
      : formatQuantity(maxFinite(absorbedPowers)!, absorbedPowerDensityUnit),
    meanAmplitude: meanFinite(amplitudes) == null
      ? "not available"
      : formatQuantity(meanFinite(amplitudes)!, amplitudeUnit),
    observableId: observableId ?? "not selected",
    peakAmplitude: maxFinite(amplitudes) == null
      ? "not available"
      : formatQuantity(maxFinite(amplitudes)!, amplitudeUnit),
    phaseRange: formatNumberRange(phases, " rad"),
    pointCount: String(points.length),
    resourceKey:
      ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  };
}

function useFrequencyResponseSweepSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const susceptibilityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "susceptibility-max-abs",
  );
  const fmrPeakModel = buildFmrPeakTableModel({
    manifestPayload: frequencyDomainManifestPayload(manifest.data),
    responseSweep: responseSweep.data,
    spectrum: null,
  });
  const frequencies = responseModel.points.map((point) => point.frequencyHz);
  const phases = responseModel.points.flatMap((point) =>
    point.phaseRad == null ? [] : [point.phaseRad],
  );
  const absorbedPowers = responseModel.points.flatMap((point) =>
    point.absorbedPowerDensity == null ? [] : [point.absorbedPowerDensity],
  );
  const fieldOverlayCount = responseModel.points.filter((point) => point.fieldId).length;
  const peak = fmrPeakModel.peaks.find((item) => item.source === "driven_response");

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancellationState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    fieldOverlayStatus: `${fieldOverlayCount}/${responseModel.points.length} point(s) field-ready`,
    frequencyRange: formatFrequencyRange(frequencies),
    maxAbsorbedPowerDensity: maxFinite(absorbedPowers) == null
      ? "not available"
      : formatQuantity(maxFinite(absorbedPowers)!, absorbedPowerDensityUnit),
    peakResponse: peak
      ? `${formatFrequency(peak.frequencyHz)}; amplitude ${formatQuantity(peak.amplitude, amplitudeUnit)}`
      : "not available",
    pointCount: String(responseModel.points.length),
    progressState: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    phaseCoverage: `${phases.length}/${responseModel.points.length} point(s)`,
    responseSeriesControls:
      "Amplitude, Phase, Absorbed power density, Max |susceptibility|",
    resourceKey: responseSweep.data?.resource_key ??
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    responseModel,
    amplitudeUnit,
    absorbedPowerDensityUnit,
    seriesStatus: responseModel.series.length
      ? `${responseModel.series.length} series: ${responseModel.series.map((series) => series.label).join(", ")}`
      : "not available",
    absorbedPowerCoverage: `${absorbedPowers.length}/${responseModel.points.length} point(s)`,
    susceptibilityComponent: `max |χ| from response tensor [${susceptibilityUnit}]`,
    susceptibilityUnit,
  };
}

function useFrequencyResponseDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const diagnostics = useFrequencyDomainResponseDiagnosticsResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const diagnosticsPayload = record(diagnostics.data?.payload);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const response = manifest.data?.response;
  const studyKind = response?.study_kind ?? "frequency_response";
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const responseCapabilities = record(capabilities?.response);
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;
  const residualCount = responseModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const krylovPreconditionerKind = stringValue(
    diagnosticsPayload?.krylov_preconditioner_kind,
  );
  const krylovPreconditionerVariant = stringValue(
    diagnosticsPayload?.krylov_preconditioner_variant,
  );

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancelState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    capabilitySummary: `frequency_sweep: ${capabilityStatus(responseCapabilities?.frequency_sweep)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    drivenAvailability: `${studyKind}: ${response?.status ?? "missing"}; driven=${String(
      response?.driven_response_available ?? false,
    )}; static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; gpu=${String(response?.gpu_available ?? false)}`,
    krylovPreconditioner: krylovPreconditionerVariant
      ? `${krylovPreconditionerVariant}${krylovPreconditionerKind ? ` (${krylovPreconditionerKind})` : ""}`
      : (krylovPreconditionerKind ?? "not reported"),
    residualCoverage: `${residualCount}/${responseModel.points.length} point(s)`,
    responseArtifact: responseSweep.data?.artifact_path ?? "not available",
    responseFields: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    sweepProgress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
  };
}

function useFrequencyDomainJobsSummary() {
  const runSummary = useFrequencyDomainRunSummary();
  const eigenSummary = useEigenSampleJobSummary();
  const responseSummary = useFrequencyResponseFrequencyJobSummary();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const exportsSummary = useFrequencyDomainExportsSummary();
  const progressSummary = frequencyResponseSweepStatusSummary({
    data: progress.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    status: progress.status,
  });
  const cancelSummary = frequencyResponseSweepStatusSummary({
    data: cancelRequested.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    status: cancelRequested.status,
  });

  return {
    artifactExport: exportsSummary.badge,
    badge: progressSummary.runtimeState,
    cancelCheckpoint: cancelRequested.data
      ? `${cancelSummary.runtimeState}; ${cancelSummary.progress}; partial artifacts ${cancelSummary.partialArtifacts}; range ${cancelSummary.frequencyRange}; ${cancelSummary.solverProgress}`
      : "not requested",
    eigenSamples: eigenSummary.kPathSamples,
    responseFrequencies: responseSummary.frequencyWorkUnits,
    responseProgress: `${progressSummary.runtimeState}; ${progressSummary.progress}; written ${progressSummary.writtenArtifacts}; range ${progressSummary.frequencyRange}; ${progressSummary.solverProgress}`,
    stageRun: `${runSummary.stageKind}; ${runSummary.calculationMode}`,
  };
}

function useEigenSampleJobSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion.data,
    branchesModel,
  );
  const eigenmodes = manifest.data?.eigenmodes;
  const modeFieldCount = spectrumModel.points.filter((point) => point.modeFieldId)
    .length;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );

  return {
    badge:
      dispersion.status === "ready"
        ? `${dispersionModel.points.length} sample(s)`
        : dispersion.status,
    branchTracking: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    kPathSamples: `${dispersionModel.points.length} point(s)`,
    modeFields: `${modeFieldCount} field-ready`,
    outputResources: `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH}; ${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH}`,
    solverLane: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
  };
}

function useFrequencyResponseFrequencyJobSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const response = manifest.data?.response;
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;
  const residualCount = responseModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const progressSummary = frequencyResponseSweepStatusSummary({
    data: progress.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    status: progress.status,
  });
  const cancelSummary = frequencyResponseSweepStatusSummary({
    data: cancelRequested.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    status: cancelRequested.status,
  });

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} frequency point(s)`
        : responseSweep.status,
    cancelCheckpoint: cancelRequested.data
      ? `${cancelSummary.runtimeState}; ${cancelSummary.progress}; range ${cancelSummary.frequencyRange}; ${cancelSummary.solverProgress}`
      : "not requested",
    fieldArtifacts: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    frequencyWorkUnits: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
    residualCoverage: `${residualCount}/${responseModel.points.length} point(s)`,
    solverLane: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}`,
    sweepProgress: `${progressSummary.runtimeState}; ${progressSummary.progress}; range ${progressSummary.frequencyRange}; ${progressSummary.solverProgress}`,
    sweepResource:
      responseSweep.data?.resource_key ??
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  };
}

function useFrequencyDomainDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const solver = useFrequencyDomainSolverDiagnosticSummary();
  const artifacts = useFrequencyDomainExportsSummary();
  const api = useFrequencyDomainApiResourceDiagnosticSummary();
  const visualization = useFrequencyDomainVisualizationDiagnosticSummary();
  const boundaryCapabilities = record(record(manifest.data?.capabilities)?.boundary);

  return {
    apiResources: `${api.manifestEndpoint}; ${api.responseEndpoint}`,
    artifacts: artifacts.bundle,
    badge: "diagnostics",
    capabilityGates: `modal ${capabilityStatus(
      boundaryCapabilities?.floquet_modal,
    )}; response ${capabilityStatus(
      boundaryCapabilities?.floquet_response,
    )}`,
    solverState: solver.executionLane,
    visualization: `${visualization.modeOverlays}; ${visualization.responseOverlays}`,
  };
}

function useFrequencyDomainCapabilitiesDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const boundaryCapabilities = record(capabilities?.boundary);
  const demagCapabilities = record(capabilities?.demag);
  const visualizationCapabilities = record(capabilities?.visualization);

  return {
    badge: manifest.data?.schema_version ?? manifest.status,
    boundaryGates: `floquet_modal: ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; floquet_response: ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    demagGates: `static_periodic_pbc: ${capabilityStatus(demagCapabilities?.static_periodic_pbc)}; dynamic_demag_k: ${capabilityStatus(demagCapabilities?.floquet_dynamic_k)}`,
    drivenLane: `frequency_sweep: ${capabilityStatus(responseCapabilities?.frequency_sweep)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    modalLane: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; mode_field_payload: ${capabilityStatus(modalCapabilities?.mode_field_payload)}`,
    visualizationGates: `mode_3d_overlay: ${capabilityStatus(visualizationCapabilities?.mode_3d_overlay)}; response_field_3d_overlay: ${capabilityStatus(visualizationCapabilities?.response_field_3d_overlay)}`,
  };
}

function useFrequencyDomainEquilibriumDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const response = manifest.data?.response;
  const eigenmodes = manifest.data?.eigenmodes;

  return {
    badge: stringValue(manifestPayload?.stage_kind) ?? "not available",
    modalReadiness: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
    responseReadiness: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}; static_periodic=${String(response?.static_periodic_response_available ?? false)}`,
    source: "stage://equilibrium/m0",
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
    tangentContract: "m0-normalized tangent-space linearization",
  };
}

function useFrequencyDomainOperatorDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const boundaryCapabilities = record(capabilities?.boundary);
  const demagCapabilities = record(capabilities?.demag);

  return {
    badge: "operator",
    boundaryPolicy: `floquet_modal: ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; static_periodic: ${capabilityStatus(boundaryCapabilities?.static_periodic)}`,
    demagKGate: `dynamic_demag_k: ${capabilityStatus(demagCapabilities?.floquet_dynamic_k)}`,
    normalization: stringValue(physics?.normalization) ?? "not available",
    operatorFamily: "linearized LLG tangent operator",
    phaseConvention: stringValue(physics?.phase_convention) ?? "not available",
  };
}

function useFrequencyDomainSolverDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const eigenDiagnostics = useFrequencyDomainEigenDiagnosticsResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseResidualCount = responseModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const modalResidualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const modalDiagnostics = eigenDiagnosticTransportSummary(eigenDiagnostics.data);

  return {
    badge: responseSweep.status,
    cancelState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    executionLane: responseExecutionLaneFromManifest(manifest.data?.response),
    modalTransport: `${modalDiagnostics.solverModel}; ${modalDiagnostics.transport}`,
    modalResiduals: `${modalResidualCount}/${spectrumModel.points.length} mode(s)`,
    productionCpuGate: modalDiagnostics.productionCpuGate,
    progress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    responseResiduals: `${responseResidualCount}/${responseModel.points.length} point(s)`,
  };
}

function useFrequencyDomainApiResourceDiagnosticSummary() {
  return {
    badge: "resource-first",
    eigenDiagnosticsEndpoint: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
    fieldEndpoint: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
    manifestEndpoint: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    progressEndpoint: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    responseEndpoint: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    spectrumEndpoint: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  };
}

function useFrequencyDomainVisualizationDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modeFieldCount = spectrumModel.points.filter((point) => point.modeFieldId)
    .length;

  return {
    animation: "phase-rotated real, real, imag, abs, phase animation",
    badge: frequencyDomainVisualizationReadiness({
      modeFieldCount,
      responseFieldCount,
    }),
    chartReadiness: `${spectrumModel.series.length} modal series, ${responseModel.series.length} response series`,
    modeOverlays: `${modeFieldCount} mode field payload(s)`,
    responseOverlays: `${responseFieldCount} response field artifact(s)`,
    viewportHandoff: "selection -> command registry -> unified viewport field",
  };
}

export function frequencyDomainVisualizationReadiness({
  modeFieldCount,
  responseFieldCount,
}: {
  modeFieldCount: number;
  responseFieldCount: number;
}): string {
  if (modeFieldCount > 0 && responseFieldCount > 0) return "3D ready";
  if (modeFieldCount > 0) return "response fields missing";
  if (responseFieldCount > 0) return "mode fields missing";
  return "field artifacts missing";
}

function frequencyResponseSweepStatusSummary({
  data,
  resourceKey,
  status,
}: {
  data: {
    complete?: boolean | null;
    completed_frequency_points?: number | null;
    current_frequency_hz?: number | null;
    demag_mode?: string | null;
    frequency_max_hz?: number | null;
    frequency_min_hz?: number | null;
    latest_artifact_manifest_path?: string | null;
    missing_reason?: string | null;
    partial_artifacts_available?: boolean | null;
    progress_json?: string | null;
    state?: string | null;
    status?: string | null;
    total_frequency_points?: number | null;
    written_frequency_point_artifacts?: number | null;
  } | null;
  resourceKey: string;
  status: string;
}) {
  const completed = data?.completed_frequency_points ?? null;
  const total = data?.total_frequency_points ?? null;
  const progress =
    completed == null || total == null
      ? "not available"
      : `${completed}/${total} frequency points`;
  const progressPercent = frequencyResponseProgressPercent(data);
  const runtimeState = data
    ? `${data.state ?? data.status ?? status}`
    : status;

  return {
    badge: runtimeState,
    complete: data?.complete === true ? "yes" : data?.complete === false ? "no" : "unknown",
    currentFrequency: formatFrequency(frequencyResponseCurrentFrequency(data)),
    frequencyRange: frequencyResponseProgressRangeSummary(data),
    latestManifest: data?.latest_artifact_manifest_path ?? "not available",
    partialArtifacts:
      data?.partial_artifacts_available === true
        ? "yes"
        : data?.partial_artifacts_available === false
          ? "no"
          : "unknown",
    progress,
    progressLabel: progress,
    progressPercent,
    reason: data?.missing_reason ?? "none",
    resourceKey,
    runtimeState,
    solverProgress: frequencyResponseProgressSolverSummary(data),
    status: data?.status ?? status,
    writtenArtifacts:
      data?.written_frequency_point_artifacts == null
        ? "not available"
        : String(data.written_frequency_point_artifacts),
  };
}

function frequencyResponseProgressRangeSummary(data: {
  frequency_max_hz?: number | null;
  frequency_min_hz?: number | null;
  progress_json?: string | null;
} | null): string {
  const topLevelRange = formatFrequencyRangeFromBounds(
    data?.frequency_min_hz,
    data?.frequency_max_hz,
  );
  if (topLevelRange !== "not available") return topLevelRange;
  const payload = parsedJsonRecord(data?.progress_json);
  return formatFrequencyRangeFromBounds(
    finiteOptionalNumber(payload?.frequency_min_hz),
    finiteOptionalNumber(payload?.frequency_max_hz),
  );
}

function frequencyResponseCurrentFrequency(data: {
  current_frequency_hz?: number | null;
  progress_json?: string | null;
} | null): number | null {
  const topLevelFrequency = finiteOptionalNumber(data?.current_frequency_hz);
  if (topLevelFrequency != null) return topLevelFrequency;
  const payload = parsedJsonRecord(data?.progress_json);
  return finiteOptionalNumber(payload?.current_frequency_hz);
}

function frequencyResponseProgressPercent(data: {
  complete?: boolean | null;
  completed_frequency_points?: number | null;
  progress_json?: string | null;
  total_frequency_points?: number | null;
} | null): number | null {
  if (data?.complete === true) return 100;
  const payload = parsedJsonRecord(data?.progress_json);
  const total =
    finiteOptionalNumber(data?.total_frequency_points) ??
    finiteOptionalNumber(payload?.total_frequency_points);
  if (total == null || total <= 0) return null;
  const completed = clampNumber(
    finiteOptionalNumber(data?.completed_frequency_points) ??
      finiteOptionalNumber(payload?.completed_frequency_points) ??
      0,
    0,
    total,
  );
  const nativeFrequencyIndex = finiteOptionalNumber(
    payload?.native_frequency_index,
  );
  const nativeSolveFraction = finiteOptionalNumber(
    payload?.native_current_frequency_solve_fraction,
  );
  const activeWork =
    nativeFrequencyIndex == null || nativeSolveFraction == null
      ? completed
      : Math.max(
          completed,
          clampNumber(nativeFrequencyIndex, 0, total) +
            clampNumber(nativeSolveFraction, 0, 1),
        );
  return clampNumber(
    Math.round((clampNumber(activeWork, 0, total) / total) * 100),
    0,
    100,
  );
}

function frequencyResponseProgressSolverSummary(data: {
  demag_mode?: string | null;
  progress_json?: string | null;
} | null): string {
  const payload = parsedJsonRecord(data?.progress_json);
  const parts = [
    data?.demag_mode ?? stringValue(payload?.demag_mode),
    formatGmresIteration(
      payload?.native_iteration_count,
      payload?.native_max_iterations_for_frequency,
    ),
    formatNativeSolveFraction(payload?.native_current_frequency_solve_fraction),
    formatProgressRelativeResidual(payload?.native_relative_residual_l2_norm),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("; ") : "not available";
}

function formatFrequencyRangeFromBounds(
  minHz: number | null | undefined,
  maxHz: number | null | undefined,
): string {
  if (
    minHz == null ||
    maxHz == null ||
    !Number.isFinite(minHz) ||
    !Number.isFinite(maxHz) ||
    minHz <= 0 ||
    maxHz <= 0 ||
    maxHz < minHz
  ) {
    return "not available";
  }
  if (minHz === maxHz) return formatFrequency(minHz);
  return `${formatFrequency(minHz)}-${formatFrequency(maxHz)}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOptionalNumber(value: unknown): number | null {
  return value == null ? null : finiteNumber(value);
}

function formatGmresIteration(
  value: unknown,
  maxValue?: unknown,
): string | null {
  const iteration = finiteOptionalNumber(value);
  if (iteration == null) return null;
  const maxIteration = finiteOptionalNumber(maxValue);
  return maxIteration == null
    ? `GMRES ${Math.round(iteration)}`
    : `GMRES ${Math.round(iteration)}/${Math.round(maxIteration)}`;
}

function formatNativeSolveFraction(value: unknown): string | null {
  const fraction = finiteOptionalNumber(value);
  if (fraction == null) return null;
  return `solve ${Math.round(clampNumber(fraction, 0, 1) * 100)}%`;
}

function formatProgressRelativeResidual(value: unknown): string | null {
  const residual = finiteOptionalNumber(value);
  return residual == null ? null : `relres ${residual.toExponential(3)}`;
}

function useFrequencyDomainPeriodicPairsSummary() {
  const periodicPairs = useMeshPeriodicPairsResource();
  const pairs = periodicPairs.data?.pairs ?? [];
  const representativePair = pairs[0] ?? null;
  const invalidCount = pairs.filter((pair) => pair.status !== "ready").length;
  const maxResidual = pairs.reduce<number | null>((current, pair) => {
    const residual = finiteNumber(pair.max_residual_m);
    if (residual == null) return current;
    return current == null ? residual : Math.max(current, residual);
  }, null);

  return {
    badge: periodicPairs.data
      ? periodicStatusView(periodicPairs.data.status).label
      : periodicPairs.status,
    invalidPairs: String(invalidCount),
    maxResidual:
      maxResidual == null ? "not available" : `${formatNumber(maxResidual)} m`,
    pairCount: `${pairs.length} pair(s)`,
    representativePair: representativePair
      ? `${representativePair.pair_id}; markers ${representativePair.marker_a}/${representativePair.marker_b}`
      : "not available",
  };
}

function useFrequencyDomainPeriodicFloquetSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const periodicPairs = useFrequencyDomainPeriodicPairsSummary();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spinWaveBc = record(manifestPayload?.spin_wave_bc);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const boundaryCapabilities = record(capabilities?.boundary);
  const demagCapabilities = record(capabilities?.demag);

  return {
    badge: manifest.data?.floquet_nonzero_k_demag_supported
      ? "demag-k supported"
      : "demag-k rejected",
    dynamicDemagK: capabilityStatus(demagCapabilities?.floquet_dynamic_k),
    floquetGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    meshResidual: periodicPairs.maxResidual,
    periodicPairs: periodicPairs.pairCount,
    phaseConvention:
      stringValue(spinWaveBc?.phase_convention) ?? "exp(-i k dot delta_r)",
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isDrivenExcitationMissing(manifestPayload: unknown): boolean {
  if (!manifestPayload) return false;
  const payload = record(manifestPayload);
  if (!payload) return true;
  const excitation = record(payload.excitation);
  if (!excitation) return true;
  const field = excitation.field_au_per_m || excitation.excitation_field;
  if (!field || !Array.isArray(field)) return true;
  return field.every(v => v === 0);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsedJsonRecord(value: unknown): Record<string, unknown> | null {
  const source = stringValue(value);
  if (!source) return null;
  try {
    return record(JSON.parse(source));
  } catch {
    return null;
  }
}

function eigenDiagnosticTransportSummary(data: unknown): {
  productionCpuGate: string;
  solverModel: string;
  transport: string;
} {
  const artifact = record(data);
  const payload = record(artifact?.payload) ?? artifact;
  const solverModel =
    stringValue(payload?.solver_model) ??
    stringValue(payload?.solverModel) ??
    "not available";
  const transportPolicy =
    stringValue(payload?.basis_transport_policy) ??
    stringValue(payload?.basisTransportPolicy) ??
    "not available";
  const frameMismatch = finiteNumber(
    payload?.floquet_tangent_frame_max_mismatch ??
      payload?.floquetTangentFrameMaxMismatch,
  );
  const nonunitarity = finiteNumber(
    payload?.floquet_tangent_transport_max_nonunitarity ??
      payload?.floquetTangentTransportMaxNonunitarity,
  );
  const productionCpuRejectionReason =
    stringValue(payload?.production_cpu_rejection_reason) ??
    stringValue(payload?.productionCpuRejectionReason);
  const productionCpuRejectionScope =
    stringValue(payload?.production_cpu_rejection_scope) ??
    stringValue(payload?.productionCpuRejectionScope);
  const executionLane =
    stringValue(payload?.execution_lane) ??
    stringValue(payload?.executionLane) ??
    stringValue(payload?.resolved_execution_lane) ??
    stringValue(payload?.resolvedExecutionLane);
  const solverAdapter =
    stringValue(payload?.solver_adapter) ??
    stringValue(payload?.solverAdapter);
  const productionSolverAvailable =
    payload?.production_solver_available === true ||
    payload?.productionSolverAvailable === true;
  const sampleCount =
    finiteNumber(payload?.sample_count) ??
    finiteNumber(payload?.sampleCount);
  const acceptedProductionCpuGate =
    !productionCpuRejectionReason &&
    (executionLane === "production_cpu" ||
      productionSolverAvailable ||
      solverAdapter === "slepc_modal_eigen");

  return {
    productionCpuGate: productionCpuRejectionReason
      ? `${productionCpuRejectionReason}; ${
          productionCpuRejectionScope ?? "scope not reported"
        }`
      : acceptedProductionCpuGate
        ? `accepted production_cpu selected-spectrum modal k-path; adapter ${
            solverAdapter ?? "not reported"
          }; sample_count ${formatNullableNumber(sampleCount)}`
        : "not reported",
    solverModel,
    transport: `${transportPolicy}; frame mismatch ${formatNullableNumber(frameMismatch)}; nonunitarity ${formatNullableNumber(nonunitarity)}`,
  };
}

function formatNullableNumber(value: number | null): string {
  return value == null ? "not available" : formatNumber(value);
}

function responseExecutionLaneFromManifest(response: unknown): string {
  const responseRecord = record(response);
  const diagnostics = parsedJsonRecord(responseRecord?.diagnostics_json);
  const executionLane =
    stringValue(diagnostics?.execution_lane) ??
    stringValue(diagnostics?.resolved_execution_lane) ??
    stringValue(diagnostics?.requested_execution_lane);
  const responseStatus = stringValue(responseRecord?.status) ?? "missing";
  return `${executionLane ?? "not reported"}; response=${responseStatus}`;
}

function requestedMagnetostaticBc(
  manifestPayload: Record<string, unknown> | null,
): string {
  const requestedExecution = record(manifestPayload?.requested_execution);
  return (
    stringValue(manifestPayload?.magnetostatic_bc) ??
    stringValue(requestedExecution?.magnetostatic_bc) ??
    "not available"
  );
}

function numericArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = finiteNumber(entry);
    return parsed == null ? [] : [parsed];
  });
}

function formatSpinWaveBc(
  manifestPayload: Record<string, unknown> | null,
): string {
  const requestedExecution = record(manifestPayload?.requested_execution);
  const spinWaveBc =
    record(manifestPayload?.spin_wave_bc) ??
    record(requestedExecution?.spin_wave_bc);
  if (!spinWaveBc) return "not available";
  const kind = stringValue(spinWaveBc.kind) ?? "not available";
  const phase =
    stringValue(spinWaveBc.phase_convention) ??
    stringValue(spinWaveBc.phaseConvention) ??
    "not available";
  const kVector = numericArray(
    spinWaveBc.floquet_k_vector_rad_per_m ??
      spinWaveBc.k_vector_rad_per_m ??
      spinWaveBc.k_vector,
  );
  if (kVector.length === 0) {
    return `${kind}; phase ${phase}`;
  }
  return `${kind}; k [${kVector.map(formatNumber).join(", ")}] rad/m; phase ${phase}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatNumberOrUnavailable(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : formatNumber(value);
}

function formatQuantity(
  value: number | null | undefined,
  unit: string,
): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${formatNumber(value)} ${unit === "not published" ? "[unit not published]" : unit}`;
}

function formatFmrModalPairLabel(pair: FmrModalDrivenComparisonPoint): string {
  const mode = pair.modalPeak.modeRef?.rawModeIndex ?? "?";
  return `mode ${mode} @ ${formatFrequency(pair.modalPeak.frequencyHz)}`;
}

function formatFmrDrivenPairLabel(pair: FmrModalDrivenComparisonPoint): string {
  return `response @ ${formatFrequency(pair.drivenPeak.frequencyHz)}`;
}

function formatFmrPairFieldHandoff(
  pair: FmrModalDrivenComparisonPoint,
): string {
  const modal = pair.modalPeak.fieldId ? "mode field ready" : "mode field missing";
  const driven = pair.drivenPeak.fieldId
    ? "driven field ready"
    : "driven field missing";
  return `${modal}; ${driven}`;
}

function formatFmrPairAmplitudeRatio(
  pair: FmrModalDrivenComparisonPoint,
): string {
  const modalAmplitude = pair.modalPeak.amplitude;
  const drivenAmplitude = pair.drivenPeak.amplitude;
  if (
    modalAmplitude == null ||
    drivenAmplitude == null ||
    modalAmplitude === 0 ||
    !Number.isFinite(modalAmplitude) ||
    !Number.isFinite(drivenAmplitude)
  ) {
    return "not available";
  }
  return `${formatCompactNumberOrUnavailable(drivenAmplitude / modalAmplitude)} driven/modal`;
}

function formatFmrPeakSourceLabel(peak: FmrPeakPoint): string {
  return peak.source === "modal" ? "Modal eigenmode" : "Driven response";
}

function formatFmrPeakTarget(peak: FmrPeakPoint): string {
  if (peak.modeRef) {
    return `sample ${peak.modeRef.sampleIndex}, mode ${peak.modeRef.rawModeIndex}`;
  }
  if (peak.frequencyPointIndex != null) {
    return `frequency point ${peak.frequencyPointIndex}`;
  }
  return "not available";
}

function formatFmrPeakQualityFactor(peak: FmrPeakPoint): string {
  if (
    peak.linewidthHz == null ||
    peak.linewidthHz <= 0 ||
    !Number.isFinite(peak.linewidthHz)
  ) {
    return "not available";
  }
  return formatCompactNumberOrUnavailable(peak.frequencyHz / peak.linewidthHz);
}

function formatPowerDensity(
  value: number | null | undefined,
  unit = "not published",
): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : `${formatCompactNumberOrUnavailable(value)} ${unit === "not published" ? "[unit not published]" : unit}`;
}

function formatCompactNumberOrUnavailable(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${Number(value.toPrecision(6))}`;
}

function meanFinite(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxFinite(values: readonly number[]): number | null {
  if (!values.length) return null;
  return Math.max(...values);
}

function formatFrequencyRange(valuesHz: readonly number[]): string {
  return formatFrequencyRangeHz(valuesHz);
}

function formatNumberRange(values: readonly number[], unit = ""): string {
  if (!values.length) return "not available";
  return `${formatNumber(Math.min(...values))}-${formatNumber(Math.max(...values))}${unit}`;
}

function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}

function normalizedAnalysisFieldViewOptions(
  availableViews: readonly string[] | null | undefined,
  defaultView: string | null | undefined,
): readonly string[] {
  const defaultValue = normalizeAnalysisFieldView(defaultView);
  const normalized = new Set<string>();
  for (const view of availableViews?.length
    ? availableViews
    : ANALYSIS_FIELD_VIEW_OPTIONS) {
    const normalizedView = normalizeAnalysisFieldView(view);
    if (normalizedView !== defaultValue) normalized.add(normalizedView);
  }
  return [defaultValue, ...normalized];
}
