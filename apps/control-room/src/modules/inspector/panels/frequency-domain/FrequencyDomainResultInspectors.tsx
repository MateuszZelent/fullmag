"use client";

/**
 * Dedicated frequency-domain result / resource / job / diagnostic inspector
 * panel components. Each non-authoring frequency-domain node kind receives its
 * own component reference so the registry cannot silently route a new kind to a
 * generic fallback.
 */

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { Activity, Download, Eye, Play, RotateCw } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
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
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenModeResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseFrequencyPointResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchDetailChartModel,
  buildEigenBranchPointModeSelectionRef,
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFrequencyResponseChartModel,
  buildFmrModalDrivenComparisonModel,
  buildFmrPeakTableModel,
  responseFieldResourcesFromManifest,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  EigenBranch,
  EigenBranchPoint,
  EigenSpectrumPoint,
  FmrModalDrivenComparisonPoint,
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  formatFrequencyHz,
  formatFrequencyRangeHz,
} from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  FrequencyDomainModeDisplayControls,
  analysisFieldViewLabel,
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
  type FrequencyDomainCalculationModeRow,
} from "../frequencyDomainInspectorModel";

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
      <InspectorSection
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
      </InspectorSection>
      <InspectorSection
        title="Calculation Mode Matrix"
        badge={`${summary.modeRows.length} mode(s)`}
      >
        <CalculationModeTable
          activeMode={summary.activeMode}
          rows={summary.modeRows}
        />
      </InspectorSection>
      <InspectorSection
        title="Calculation Mode Result Shortcuts"
        badge={summary.activeMode}
      >
        <CalculationModeActions />
      </InspectorSection>
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
      <InspectorSection
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
      </InspectorSection>
      <InspectorSection title="Run Resource Links" badge={summary.calculationMode}>
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
      </InspectorSection>
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
      <InspectorSection
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
      </InspectorSection>
      <InspectorSection title="Result Family Shortcuts" badge={summary.badge}>
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
      </InspectorSection>
    </div>
  );
}

export function EigenProvenanceInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFrequencyDomainProvenanceSummary();

  return (
    <div data-inspector-surface="eigen-provenance">
      <InspectorSection title="Eigen Provenance" badge={summary.calculationMode}>
        <FieldRow label="Canonical family" value="Eigenmodes modal lane" />
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
      </InspectorSection>
      <InspectorSection title="Eigen Provenance Links" badge="modal">
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
      </InspectorSection>
    </div>
  );
}

export function EigenOverviewInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenOverviewSummary();

  return (
    <div data-inspector-surface="eigen-overview">
      <InspectorSection title="Eigen Results Overview" badge={summary.badge}>
        <FieldRow label="Spectrum" value={summary.spectrum} />
        <FieldRow label="Frequency coverage" value={summary.frequencyCoverage} />
        <FieldRow label="Dispersion" value={summary.dispersion} />
        <FieldRow label="Branches" value={summary.branches} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
        <FieldRow label="3D handoff" value={summary.handoff} />
      </InspectorSection>
      <InspectorSection title="Eigen Result Shortcuts" badge={summary.badge}>
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
      </InspectorSection>
    </div>
  );
}

export function EigenStudyInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenStudySummary();

  return (
    <div data-inspector-surface="eigen-study">
      <InspectorSection
        title="Eigenmodes Study Contract"
        badge={summary.badge}
      >
        <FieldRow label="Study kind" value={summary.studyKind} />
        <FieldRow label="Operator lane" value={summary.operatorLane} />
        <FieldRow label="Boundary support" value={summary.boundarySupport} />
        <FieldRow label="Artifacts" value={summary.artifacts} />
        <FieldRow label="Mode fields" value={summary.modeFields} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
      </InspectorSection>
      <InspectorSection title="Eigen Study Readback" badge="ProblemIR">
        <FieldRow
          label="Authoring source"
          value="StudyIR::Eigenmodes stage; inspector is a result readback surface"
        />
        <FieldRow
          label="Round-trip action"
          value="edit the source stage in Study; this result panel preserves provenance"
        />
      </InspectorSection>
    </div>
  );
}

export function FrequencyResponseProvenanceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainProvenanceSummary();

  return (
    <div data-inspector-surface="frequency-response-provenance">
      <InspectorSection
        title="Frequency Response Provenance"
        badge={summary.calculationMode}
      >
        <FieldRow label="Canonical family" value="FrequencyResponse driven lane" />
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Manifest artifact" value={summary.manifestArtifact} />
        <FieldRow
          label="Requested calculation"
          value={summary.calculationMode}
        />
        <FieldRow label="Stage kind" value={summary.stageKind} />
        <FieldRow label="Driven availability" value={summary.responseLane} />
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
      </InspectorSection>
      <InspectorSection title="Response Provenance Links" badge="driven">
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
      </InspectorSection>
    </div>
  );
}

export function FrequencyResponseOverviewInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseOverviewSummary();

  return (
    <div data-inspector-surface="frequency-response-overview">
      <InspectorSection
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
      </InspectorSection>
      <InspectorSection title="Response Result Shortcuts" badge={summary.badge}>
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
      </InspectorSection>
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
      <InspectorSection
        title="Frequency Response Study Contract"
        badge={summary.badge}
      >
        <FieldRow label="Study kind" value={summary.studyKind} />
        <FieldRow label="Execution lane" value={summary.executionLane} />
        <FieldRow label="Boundary support" value={summary.boundarySupport} />
        <FieldRow label="Sweep contract" value={summary.sweepContract} />
        <FieldRow label="Artifacts" value={summary.artifacts} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
      </InspectorSection>
      <InspectorSection title="Response Study Readback" badge="ProblemIR">
        <FieldRow
          label="Authoring source"
          value="StudyIR::FrequencyResponse stage; inspector is a result readback surface"
        />
        <FieldRow
          label="Round-trip action"
          value="edit excitation, sweep, solver, and outputs in the source Study stage"
        />
      </InspectorSection>
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
      {
        fieldId: point.fieldId,
        label: `${point.observableId} ${formatFrequency(point.frequencyHz)}`,
        phaseRad: point.phaseRad ?? 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
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
        label: `${peak.source} peak ${formatFrequency(peak.frequencyHz)}`,
        phaseRad: 0,
        source: peak.source === "modal" ? "eigen-mode" : "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-overview">
      <InspectorSection title="FMR Workbench" badge={summary.workflowMode}>
        <FieldRow
          label="Canonical workflows"
          value="Eigenmodes modal FMR + FrequencyResponse driven FMR"
        />
        <FieldRow label="Active chart route" value={summary.activeChartRoute} />
        <FieldRow
          label="Modal spectrum"
          value={`${summary.modalModeCount} mode(s), ${summary.modalFieldCount} overlay-ready`}
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
      </InspectorSection>
      <InspectorSection
        title="FMR workflow actions"
        badge="selection"
      >
        <FmrWorkflowActions />
      </InspectorSection>
      <InspectorSection
        title="FMR Modal Spectrum Preview"
        badge={`${summary.modalModeCount} mode(s)`}
      >
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={plotMode}
          onSelectMode={selectMode}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Driven Response Preview"
        badge={`${summary.responsePointCount} point(s)`}
      >
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={plotResponsePoint}
          onSelectPoint={selectResponsePoint}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Peak Snapshot"
        badge={summary.peakBadge}
      >
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={summary.peaks}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Modal-Driven Comparison Snapshot"
        badge={summary.comparisonState}
      >
        <FmrComparisonPairTable pairs={summary.comparisonPairs} />
      </InspectorSection>
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
  const selectBranch = (branch: EigenBranch): void => {
    void branch;
  };

  return (
    <div data-inspector-surface="frequency-domain-dispersion">
      <InspectorSection
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
          label="Dispersion points"
          value={`${summary.dispersionPointCount} point(s), ${summary.dispersionSeriesCount} series`}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="k-path span" value={summary.kPathSpan} />
        <FieldRow
          label="Branch tracking"
          value={`${summary.branchCount} branch(es), ${summary.trackedPointCount} tracked point(s)`}
        />
        <FieldRow label="Primary branch" value={summary.primaryBranch} />
        <FieldRow label="Modal overlays" value={summary.modalOverlays} />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
      </InspectorSection>
      <InspectorSection title="Dispersion Chart" badge={summary.badge}>
        <FrequencyDomainDispersionChart model={summary.dispersionModel} />
      </InspectorSection>
      <InspectorSection
        title="Dispersion Branch Table"
        badge={`${summary.branchCount} branch(es)`}
      >
        <FrequencyDomainBranchTable
          branches={summary.branchesModel.branches}
          onSelectBranch={selectBranch}
        />
      </InspectorSection>
    </div>
  );
}

export function EigenKPathInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFrequencyDomainDispersionSummary();

  return (
    <div data-inspector-surface="eigen-k-path">
      <InspectorSection title="Eigen k-Path Inspector" badge={summary.badge}>
        <FieldRow
          label="Canonical workflow"
          value="dispersion_modal -> StudyIR::Eigenmodes"
        />
        <FieldRow
          label="Dispersion resource"
          value={summary.dispersionResource}
        />
        <FieldRow label="k-path span" value={summary.kPathSpan} />
        <FieldRow
          label="Frequency coverage"
          value={summary.frequencyRange}
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
      </InspectorSection>
      <InspectorSection title="Dispersion Chart" badge={summary.badge}>
        <FrequencyDomainDispersionChart model={summary.dispersionModel} />
      </InspectorSection>
    </div>
  );
}

export function EigenDispersionInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFrequencyDomainDispersionSummary();

  return (
    <div data-inspector-surface="eigen-dispersion">
      <InspectorSection title="Eigen Dispersion Inspector" badge={summary.badge}>
        <FieldRow
          label="Dispersion resource"
          value={summary.dispersionResource}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="k-path span" value={summary.kPathSpan} />
        <FieldRow
          label="Branch tracking"
          value={`${summary.branchCount} branch(es), ${summary.trackedPointCount} tracked point(s)`}
        />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
      </InspectorSection>
    </div>
  );
}

export function EigenBranchesInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenBranchesSummary();

  return (
    <div data-inspector-surface="eigen-branches-table">
      <InspectorSection title="Eigen Branch Table" badge={summary.badge}>
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
      </InspectorSection>
    </div>
  );
}

export function EigenBranchInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenBranchSummary(props);

  return (
    <div data-inspector-surface="eigen-branch-detail">
      <InspectorSection title="Eigen Branch Detail" badge={summary.badge}>
        <FieldRow label="Branch identity" value={summary.branchIdentity} />
        <FieldRow label="Branch resource" value={summary.branchResource} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Tracked points" value={summary.trackedPoints} />
        <FieldRow label="Continuity" value={summary.continuity} />
        <FieldRow label="Representative mode" value={summary.representativeMode} />
        <FieldRow label="3D handoff" value={summary.handoff} />
      </InspectorSection>
      <InspectorSection
        title="Branch Continuity Charts"
        badge={summary.chartBadge}
      >
        <BranchContinuityCharts branch={summary.branch} />
      </InspectorSection>
      <InspectorSection
        title="Tracked Branch Samples"
        badge={summary.sampleTableBadge}
      >
        <BranchSampleTable branch={summary.branch} />
      </InspectorSection>
    </div>
  );
}

function BranchContinuityCharts({ branch }: { branch: EigenBranch | null }) {
  const chartModel = buildEigenBranchDetailChartModel(branch);

  if (!branch || chartModel.frequencySeries.length === 0) {
    return (
      <div className="fm-frequency-domain-chart__empty" role="status">
        No branch continuity samples available.
      </div>
    );
  }

  return (
    <div className="fm-frequency-domain-branch-charts">
      <div
        aria-label="Frequency-domain branch frequency chart"
        className="fm-frequency-domain-chart"
        data-renderer="summary"
      >
        <div className="fm-frequency-domain-chart__header">
          <span>Frequency vs sample</span>
          <small>{formatFrequencyRange(chartModel.frequencySeries.map((point) => point.valueHz))}</small>
        </div>
        <div className="fm-frequency-domain-chart__canvas" />
        <div className="fm-frequency-domain-chart__summary">
          {chartModel.frequencySeries.map((point) => (
            <span key={`${point.sampleIndex}:${point.label}`}>
              {point.label}: {formatFrequency(point.valueHz)}
            </span>
          ))}
        </div>
      </div>
      <div
        aria-label="Frequency-domain branch overlap chart"
        className="fm-frequency-domain-chart"
        data-renderer="summary"
      >
        <div className="fm-frequency-domain-chart__header">
          <span>Overlap vs sample</span>
          <small>
            {chartModel.overlapSeries.length > 0
              ? `${chartModel.overlapSeries.length} overlap point(s)`
              : "overlap unavailable"}
          </small>
        </div>
        <div className="fm-frequency-domain-chart__canvas" />
        <div className="fm-frequency-domain-chart__summary">
          {chartModel.overlapSeries.length > 0 ? (
            chartModel.overlapSeries.map((point) => (
              <span key={`${point.sampleIndex}:${point.label}`}>
                {point.label}: {formatCompactNumberOrDash(point.value)}
              </span>
            ))
          ) : (
            <span>overlap unavailable for first tracked point</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BranchSampleTable({ branch }: { branch: EigenBranch | null }) {
  const kernel = useKernel();

  if (!branch || branch.points.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No tracked samples available for this branch.
      </div>
    );
  }

  const rows = branch.points.toSorted(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.rawModeIndex - right.rawModeIndex,
  );
  const openMode = (point: EigenBranchPoint): void => {
    const modeRef = buildEigenBranchPointModeSelectionRef(
      branch.branchId,
      point,
    );
    kernel.selection.set(
      {
        kind: modeRef.kind,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        nodeId: modeRef.nodeId,
        objectId: null,
        ref: modeRef,
      },
      "inspector",
    );
  };
  const plotMode = (point: EigenBranchPoint): void => {
    if (!point.modeFieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.branch",
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
  const exportBranchCsv = (): void => {
    void navigator.clipboard.writeText(branchSamplesCsv(branch));
  };

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain branch sample table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Sample</th>
            <th>Raw mode</th>
            <th>Frequency</th>
            <th>Imag freq.</th>
            <th>Overlap</th>
            <th>Residual</th>
            <th>Mode field</th>
            <th className="fm-frequency-domain-table__actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => {
            const hasModeField = Boolean(
              point.modeFieldId ?? point.modeFieldResourceKey,
            );
            const rowKey = `${point.sampleIndex}:${point.rawModeIndex}`;
            return (
              <tr
                data-status={hasModeField ? "ready" : "missing"}
                key={rowKey}
              >
                <td>{point.sampleIndex}</td>
                <td>{point.rawModeIndex}</td>
                <td>{formatFrequency(point.frequencyRealHz)}</td>
                <td>{formatFrequency(point.frequencyImagHz)}</td>
                <td>{formatCompactNumberOrDash(point.overlapPrev)}</td>
                <td>{formatResidual(point.residualNorm)}</td>
                <td>{hasModeField ? "available" : "missing"}</td>
                <td className="fm-frequency-domain-table__actions">
                  <Button
                    aria-label={`Open sample ${point.sampleIndex} mode ${point.rawModeIndex}`}
                    className="fm-inspector-action-button"
                    size="sm"
                    title={`Open sample ${point.sampleIndex} mode ${point.rawModeIndex}`}
                    type="button"
                    variant="secondary"
                    onClick={() => openMode(point)}
                  >
                    <Eye aria-hidden="true" size={13} />
                    <span>Open mode</span>
                  </Button>
                  <Button
                    aria-label={`Plot sample ${point.sampleIndex} mode ${point.rawModeIndex} in 3D`}
                    className="fm-inspector-action-button"
                    disabled={!hasModeField}
                    size="sm"
                    title={
                      hasModeField
                        ? `Plot sample ${point.sampleIndex} mode ${point.rawModeIndex} in 3D`
                        : "Mode field artifact is missing"
                    }
                    type="button"
                    variant="primary"
                    onClick={() => plotMode(point)}
                  >
                    <Activity aria-hidden="true" size={13} />
                    <span>Plot 3D</span>
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="fm-frequency-domain-table__actions">
        <Button
          aria-label="Export branch CSV"
          className="fm-inspector-action-button"
          size="sm"
          title="Export branch CSV"
          type="button"
          variant="secondary"
          onClick={exportBranchCsv}
        >
          <Download aria-hidden="true" size={13} />
          <span>Export branch CSV</span>
        </Button>
      </div>
    </div>
  );
}

function branchSamplesCsv(branch: EigenBranch): string {
  const rows = [...branch.points]
    .sort(
      (left, right) =>
        left.sampleIndex - right.sampleIndex ||
        left.rawModeIndex - right.rawModeIndex,
    )
    .map((point) =>
      [
        branch.branchId,
        point.sampleIndex,
        point.rawModeIndex,
        point.frequencyRealHz,
        point.frequencyImagHz ?? "",
        point.overlapPrev ?? "",
        point.residualNorm ?? "",
        point.modeFieldId ?? point.modeFieldResourceKey ?? "",
      ].join(","),
    );

  return [
    "branch_id,sample_index,raw_mode_index,frequency_real_hz,frequency_imag_hz,overlap_prev,residual_norm,mode_field",
    ...rows,
  ].join("\n");
}

export function FrequencyDomainResponseMapInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainResponseMapSummary();

  return (
    <div data-inspector-surface="frequency-domain-response-map">
      <InspectorSection title="Response Map Control" badge={summary.badge}>
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
      </InspectorSection>
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
      <InspectorSection title="Eigen Spectrum Workbench" badge={summary.badge}>
        <FieldRow
          label="Canonical object"
          value="StudyIR::Eigenmodes spectrum"
        />
        <FieldRow label="Spectrum resource" value={summary.spectrumResource} />
        <FieldRow
          label="Mode rows"
          value={`${summary.modeCount} mode(s), ${summary.fieldOverlayCount} field overlay(s)`}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Primary mode" value={summary.primaryMode} />
        <FieldRow label="Damping coverage" value={summary.dampingCoverage} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow
          label="3D workflow"
          value="select mode -> plot phase-rotated real overlay"
        />
        <FieldRow
          label="Capability summary"
          value={summary.capabilitySummary}
        />
      </InspectorSection>
      <InspectorSection title="Spectrum Chart" badge={summary.badge}>
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={(point) => plotMode(point)}
        />
      </InspectorSection>
      <InspectorSection title="Mode Table" badge={summary.badge}>
        <FrequencyDomainModeTable
          onPlotMode={plotMode}
          points={summary.spectrumModel.points}
        />
      </InspectorSection>
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
      <InspectorSection title="Eigen Modes Browser" badge={summary.badge}>
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
      </InspectorSection>
      <InspectorSection title="Eigen Mode Browser" badge={summary.badge}>
        <FrequencyDomainModeTable
          onPlotMode={plotMode}
          points={summary.spectrumModel.points}
        />
      </InspectorSection>
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
      <InspectorSection title="Eigen Modes Visualization" badge={summary.badge}>
        <FieldRow
          label="Shared style scope"
          value="one visualization preset for the modes collection"
        />
        <FieldRow label="Mode table resource" value={summary.modeTableResource} />
        <FieldRow label="Mode table" value={summary.modeTable} />
        <FieldRow
          label="Selectable overlays"
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
      </InspectorSection>
    </div>
  );
}

export function EigenDiagnosticsInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenDiagnosticsSummary();

  return (
    <div data-inspector-surface="eigen-diagnostics">
      <InspectorSection title="Eigen Diagnostics" badge={summary.badge}>
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
        <FieldRow label="Dispersion samples" value={summary.dispersionSamples} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Demag-k gate" value={summary.demagKGate} />
      </InspectorSection>
    </div>
  );
}

export function FmrModalSpectrumInspectorPanel(props: InspectorPanelProps) {
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
  const plotMode = (
    point: EigenSpectrumPoint,
    action: FrequencyDomainModeTableAction = "phase_rotated_real",
  ): void => {
    if (action === "inspect") {
      selectMode(point);
      return;
    }
    if (!point.modeFieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr_modal_spectrum",
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
    <div data-inspector-surface="fmr-modal-spectrum">
      <InspectorSection
        title="FMR Modal Spectrum Control"
        badge={summary.modalBadge}
      >
        <FieldRow
          label="Mode workflow"
          value="modal k=0 eigenmodes -> resonances -> 3D mode overlay"
        />
        <FieldRow label="Spectrum resource" value={summary.spectrumResource} />
        <FieldRow
          label="Mode rows"
          value={`${summary.modalModeCount} modes, ${summary.modalFieldCount} 3D overlays`}
        />
        <FieldRow label="Frequency span" value={summary.modalFrequencyRange} />
        <FieldRow
          label="Primary resonance"
          value={summary.primaryModalResonance}
        />
        <FieldRow
          label="Residual coverage"
          value={summary.modalResidualCoverage}
        />
        <FieldRow
          label="Damping coverage"
          value={summary.modalDampingCoverage}
        />
        <FieldRow
          label="Overlay readiness"
          value={summary.modalFieldCount > 0 ? "mode fields available" : "mode fields missing"}
        />
        <FieldRow
          label="Visualization style scope"
          value="shared across all FMR modes; selecting a mode changes field data only"
        />
        <FieldRow label="Chart route" value={summary.modalChartRoute} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
      </InspectorSection>
      <InspectorSection
        title="FMR Modal Spectrum Chart"
        badge={`${summary.modalModeCount} mode(s)`}
      >
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={(point) => plotMode(point)}
          onSelectMode={selectMode}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Resonance Browser"
        badge={`${summary.modalModeCount} mode(s)`}
      >
        <FmrResonanceBrowser
          onPlotMode={plotMode}
          onSelectMode={selectMode}
          points={summary.spectrumModel.points}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Modal Mode Table"
        badge={`${summary.modalFieldCount} overlay(s)`}
      >
        <FrequencyDomainModeTable
          onPlotMode={plotMode}
          points={summary.spectrumModel.points}
        />
      </InspectorSection>
    </div>
  );
}

function FmrResonanceBrowser({
  onPlotMode,
  onSelectMode,
  points,
}: {
  onPlotMode: (
    point: EigenSpectrumPoint,
    action?: FrequencyDomainModeTableAction,
  ) => void;
  onSelectMode: (point: EigenSpectrumPoint) => void;
  points: readonly EigenSpectrumPoint[];
}) {
  if (points.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No modal FMR resonances available.
      </div>
    );
  }

  const sortedPoints = points.toSorted(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.frequencyHz - right.frequencyHz ||
      left.rawModeIndex - right.rawModeIndex,
  );

  return (
    <div className="fm-frequency-domain-resonance-browser">
      {sortedPoints.map((point) => (
        <article
          className="fm-frequency-domain-resonance-card"
          data-status={point.modeFieldId ? "ready" : "missing"}
          key={`${point.sampleIndex}:${point.rawModeIndex}:${point.frequencyHz}`}
        >
          <div className="fm-frequency-domain-resonance-card__header">
            <div>
              <span className="fm-frequency-domain-resonance-card__eyebrow">
                sample {point.sampleIndex}, mode {point.rawModeIndex}
              </span>
              <h4>{formatFrequency(point.frequencyHz)}</h4>
            </div>
            <span className="fm-inspector-section__badge">
              {point.modeFieldId ? "3D-ready" : "field missing"}
            </span>
          </div>
          <div className="fm-frequency-domain-resonance-card__grid">
            <FieldRow
              label="Imag frequency"
              value={formatFrequency(point.imaginaryFrequencyHz)}
            />
            <FieldRow
              label="Damping rate"
              value={formatFrequency(point.dampingRateHz)}
            />
            <FieldRow label="Residual" value={formatResidual(point.residualNorm)} />
            <FieldRow
              label="Tangent leakage"
              value={formatResidual(point.tangentLeakageMax)}
            />
            <FieldRow
              label="Branch"
              value={point.branchId ?? "not assigned"}
            />
            <FieldRow
              label="Mode field"
              value={point.modeFieldId ? "overlay-ready" : "missing"}
            />
          </div>
          <div className="fm-frequency-domain-resonance-card__actions">
            <Button
              className="fm-inspector-action-button"
              size="sm"
              title="Open this eigen mode inspector"
              type="button"
              variant="secondary"
              onClick={() => onSelectMode(point)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Inspect</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={!point.modeFieldId}
              size="sm"
              title={
                point.modeFieldId
                  ? "Plot this modal resonance in 3D"
                  : "This mode has no linked 3D field payload"
              }
              type="button"
              variant="primary"
              onClick={() => onPlotMode(point)}
            >
              <RotateCw size={13} aria-hidden="true" />
              <span>Plot 3D</span>
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function FmrResponseSweepInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFmrResultSummary();
  const kernel = useKernel();
  const drivenPeaks = summary.peaks.filter(
    (peak) => peak.source === "driven_response",
  );
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
  const plotResponsePoint = (
    point: FrequencyResponsePoint,
    action: FrequencyDomainResponsePointAction = "phase_rotated_real",
  ): void => {
    if (!point.fieldId) return;
    const animate = action === "animate";
    void kernel.commands.execute(
      animate
        ? "analysis.frequency-domain.set-3d-animation"
        : "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr_response_sweep",
      }),
      {
        animatePhase: animate ? true : undefined,
        animationRateHz: animate ? 1 : undefined,
        fieldId: point.fieldId,
        label: `${point.observableId} ${formatFrequency(point.frequencyHz)}`,
        phaseRad: point.phaseRad ?? 0,
        source: "frequency-response",
        view: animate ? "phase_rotated_real" : action,
      },
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
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr_response_sweep",
      }),
      {
        fieldId: peak.fieldId,
        label: `driven peak ${formatFrequency(peak.frequencyHz)}`,
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-response-sweep">
      <InspectorSection
        title="FMR Response Sweep Control"
        badge={summary.responseBadge}
      >
        <FieldRow
          label="Sweep workflow"
          value="driven FMR sweep -> frequency point -> 3D response field"
        />
        <FieldRow label="Sweep resource" value={summary.responseResource} />
        <FieldRow
          label="Frequency points"
          value={`${summary.responsePointCount} points, ${summary.responseSeriesCount} observable series`}
        />
        <FieldRow
          label="Response overlays"
          value={`${summary.responseFieldCount} field artifacts`}
        />
        <FieldRow
          label="Driven peak status"
          value={`${summary.drivenPeakCount} driven peaks`}
        />
        <FieldRow
          label="Response series"
          value={`${summary.responseModel.series.length} chart series`}
        />
        <FieldRow
          label="3D handoff"
          value={`${summary.responseLinkedPointCount}/${summary.responsePointCount} frequency points are directly linked; ${summary.responseFieldCount} field payloads published`}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Response Sweep Chart"
        badge={`${summary.responseSeriesCount} series`}
      >
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={(point) => plotResponsePoint(point)}
          onSelectPoint={selectResponsePoint}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Response Point Browser"
        badge={`${summary.responsePointCount} point(s)`}
      >
        <FmrResponsePointBrowser
          onPlotResponsePoint={plotResponsePoint}
          onSelectResponsePoint={selectResponsePoint}
          points={summary.responseModel.points}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Response Point Table"
        badge={`${summary.responsePointCount} point(s)`}
      >
        <FrequencyDomainResponsePointTable
          onPlotResponsePoint={plotResponsePoint}
          points={summary.responseModel.points}
        />
      </InspectorSection>
      <InspectorSection
        title="Driven FMR Peak Table"
        badge={`${drivenPeaks.length} peak(s)`}
      >
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={drivenPeaks}
        />
      </InspectorSection>
    </div>
  );
}

function FmrResponsePointBrowser({
  onPlotResponsePoint,
  onSelectResponsePoint,
  points,
}: {
  onPlotResponsePoint: (
    point: FrequencyResponsePoint,
    action?: FrequencyDomainResponsePointAction,
  ) => void;
  onSelectResponsePoint: (point: FrequencyResponsePoint) => void;
  points: readonly FrequencyResponsePoint[];
}) {
  if (points.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No driven FMR response points available.
      </div>
    );
  }

  const sortedPoints = points.toSorted(
    (left, right) =>
      left.frequencyHz - right.frequencyHz ||
      left.observableId.localeCompare(right.observableId),
  );

  return (
    <div className="fm-frequency-domain-response-browser">
      {sortedPoints.map((point, index) => (
        <article
          className="fm-frequency-domain-response-card"
          data-status={point.fieldId ? "ready" : "missing"}
          key={`${point.observableId}:${point.frequencyHz}:${point.frequencyIndex ?? index}`}
        >
          <div className="fm-frequency-domain-response-card__header">
            <div>
              <span className="fm-frequency-domain-response-card__eyebrow">
                {point.observableId}
                {point.frequencyIndex == null
                  ? ""
                  : `, frequency point ${point.frequencyIndex}`}
              </span>
              <h4>{formatFrequency(point.frequencyHz)}</h4>
            </div>
            <span className="fm-inspector-section__badge">
              {point.fieldId ? "3D-ready" : "field missing"}
            </span>
          </div>
          <div className="fm-frequency-domain-response-card__grid">
            <FieldRow
              label="Amplitude"
              value={formatNumberOrUnavailable(point.amplitude)}
            />
            <FieldRow
              label="Phase"
              value={
                point.phaseRad == null
                  ? "not available"
                  : `${formatNumber(point.phaseRad)} rad`
              }
            />
            <FieldRow
              label="Absorbed power"
              value={formatPowerDensity(point.absorbedPowerDensity)}
            />
            <FieldRow
              label="Susceptibility"
              value={formatMaxAbsSusceptibility(point.susceptibility)}
            />
            <FieldRow label="Residual" value={formatResidual(point.residualNorm)} />
            <FieldRow
              label="Response field"
              value={point.fieldId ? "overlay-ready" : "missing"}
            />
          </div>
          <div className="fm-frequency-domain-response-card__actions">
            <Button
              className="fm-inspector-action-button"
              size="sm"
              title="Open this response frequency point inspector"
              type="button"
              variant="secondary"
              onClick={() => onSelectResponsePoint(point)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Inspect</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={!point.fieldId}
              size="sm"
              title={
                point.fieldId
                  ? "Plot this response field in 3D"
                  : "This response point has no linked 3D field payload"
              }
              type="button"
              variant="primary"
              onClick={() => onPlotResponsePoint(point)}
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
        label: `${peak.source} peak ${formatFrequency(peak.frequencyHz)}`,
        phaseRad: 0,
        source: peak.source === "modal" ? "eigen-mode" : "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-peaks">
      <InspectorSection title="FMR Peak Control" badge={summary.peakBadge}>
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
      </InspectorSection>
      <InspectorSection title="FMR Peak Browser" badge={summary.peakBadge}>
        <FmrPeakBrowser
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={summary.peaks}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Peak Table"
        badge={`${summary.peakCount} peak(s)`}
      >
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={summary.peaks}
        />
      </InspectorSection>
      <InspectorSection
        title="FMR Modal-Driven Difference Table"
        badge={summary.comparisonState}
      >
        <FmrComparisonPairTable pairs={summary.comparisonPairs} />
      </InspectorSection>
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
            <span className="fm-inspector-section__badge">
              {peak.validationStatus}
            </span>
          </div>
          <div className="fm-frequency-domain-peak-card__grid">
            <FieldRow label="Target" value={formatFmrPeakTarget(peak)} />
            <FieldRow label="Amplitude" value={formatNumberOrUnavailable(peak.amplitude)} />
            <FieldRow label="Power density" value={formatPowerDensity(peak.absorbedPowerDensity)} />
            <FieldRow label="Linewidth" value={formatFrequency(peak.linewidthHz)} />
            <FieldRow label="Q factor" value={formatFmrPeakQualityFactor(peak)} />
            <FieldRow
              label="3D field"
              value={peak.fieldId ? "overlay-ready" : "missing"}
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
    <div data-inspector-surface="fmr-peak">
      <InspectorSection title="FMR Peak Workbench" badge={summary.badge}>
        <div className="fm-frequency-domain-active-peak">
          <div className="fm-frequency-domain-active-peak__header">
            <h4>{summary.frequency}</h4>
            <span className="fm-inspector-section__badge">
              {summary.sourceBadge}
            </span>
          </div>
          <FieldRow label="Peak frequency" value={summary.frequency} />
          <FieldRow label="Physical source" value={summary.source} />
          <FieldRow label="Canonical target" value={summary.target} />
          <FieldRow label="3D field payload" value={summary.fieldPayload} />
          <FieldRow label="Validation" value={summary.validation} />
        </div>
      </InspectorSection>
      <InspectorSection
        title="Peak Observables"
        badge={summary.spectralBadge}
      >
        <FieldRow label="Amplitude" value={summary.amplitude} />
        <FieldRow
          label="Absorbed power density"
          value={summary.absorbedPowerDensity}
        />
        <FieldRow label="Phase" value={summary.phase} />
        <FieldRow label="Linewidth" value={summary.linewidth} />
        <FieldRow label="Missing values" value={summary.missingSpectralValues} />
      </InspectorSection>
      <InspectorSection
        title="Visualization Handoff"
        badge={summary.actionBadge}
      >
        <FieldRow label="Default field view" value="phase-rotated real" />
        <FieldRow
          label="Display controls"
          value="shared mode-field controls: component, real/imag/magnitude, colormap, vectors, shader, phase"
        />
        <FieldRow
          label="Volume roadmap"
          value="future clip/trim plane and shader transparency belong to the shared mode-field display"
        />
        <FieldRow label="Plot readiness" value={summary.visualizationReadiness} />
        <FmrPeakActions summary={summary} />
      </InspectorSection>
      <InspectorSection
        title="Resource Provenance"
        badge={summary.provenanceBadge}
      >
        <FieldRow label="Source surface" value={summary.sourceInspectorLabel} />
        <FieldRow label="Source artifact" value={summary.artifactFamily} />
        <FieldRow label="Field ID" value={summary.fieldId ?? "not available"} />
        <FieldRow label="Data-plane resource" value={summary.dataPlaneResource} />
        <FieldRow label="Selection kind" value={props.selection.kind ?? "not available"} />
        <FieldRow label="Node ID" value={props.selection.nodeId ?? "not available"} />
      </InspectorSection>
    </div>
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
        label: formatFmrDrivenPairLabel(pair),
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-comparison">
      <InspectorSection
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
        <FieldRow label="Modal overlay" value={summary.modalOverlay} />
        <FieldRow label="Driven overlay" value={summary.drivenOverlay} />
        <FieldRow label="Validation state" value={summary.validationState} />
        <FieldRow label="Resources" value={summary.resources} />
      </InspectorSection>
      <InspectorSection
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
      </InspectorSection>
      <InspectorSection
        title="FMR Modal-Driven Pair Table"
        badge={`${summary.pairs.length} pair(s)`}
      >
        <FmrComparisonPairTable pairs={summary.pairs} />
      </InspectorSection>
      <InspectorSection
        title="FMR Comparison Actions"
        badge={summary.actionBadge}
      >
        <FieldRow label="Modal target" value={summary.modalActionTarget} />
        <FieldRow label="Driven target" value={summary.drivenActionTarget} />
        <FmrComparisonActions summary={summary} />
      </InspectorSection>
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
        <span>Plot modal overlay</span>
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
        <span>Plot driven overlay</span>
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
            <span className="fm-inspector-section__badge">
              {pair.modalPeak.validationStatus}/{pair.drivenPeak.validationStatus}
            </span>
          </div>
          <div className="fm-frequency-domain-comparison-card__grid">
            <FieldRow label="Modal" value={formatFmrModalPairLabel(pair)} />
            <FieldRow label="Driven" value={formatFmrDrivenPairLabel(pair)} />
            <FieldRow
              label="Modal field"
              value={pair.modalPeak.fieldId ? "overlay-ready" : "missing"}
            />
            <FieldRow
              label="Driven field"
              value={pair.drivenPeak.fieldId ? "overlay-ready" : "missing"}
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
      <InspectorSection
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
      </InspectorSection>
    </div>
  );
}

export const EigenModeInspectorPanel =
  function EigenModeInspectorPanel(props: InspectorPanelProps) {
    const summary = useEigenModeSummary(props);
    const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
      sourceDetail: "results.eigen.mode",
    });

    return (
      <div data-inspector-surface="eigen-mode">
        <InspectorSection title="Eigen Mode Control" badge={summary.badge}>
          <FieldRow label="Canonical object" value="Eigenmodes mode" />
          <FieldRow label="Mode identity" value={summary.modeIdentity} />
          <FieldRow label="Frequency" value={summary.frequencyDisplay} />
          <FieldRow label="Imaginary frequency" value={summary.imaginaryFrequency} />
          <FieldRow label="Angular frequency" value={summary.angularFrequency} />
          <FieldRow label="Mode field" value={summary.fieldStatus} />
          <FieldRow label="Mode field resource" value={summary.fieldResource} />
          <FieldRow label="Available field views" value={summary.availableViews} />
          <FieldRow label="Residual" value={summary.residual} />
          <FieldRow
            label="Tangent leakage max"
            value={summary.tangentLeakageMax}
          />
          <FieldRow
            label="Dominant polarization"
            value={summary.dominantPolarization}
          />
          <FieldRow label="3D workflow" value={summary.workflow} />
        </InspectorSection>
        <InspectorSection
          title="Eigen Mode 3D Visualization"
          badge={summary.actionBadge}
        >
          <FieldRow label="Field ID" value={summary.fieldIdLabel} />
          <FieldRow label="Field resource" value={summary.fieldResource} />
          <FieldRow label="Default view" value={summary.defaultViewLabel} />
          <FieldRow label="Phase convention" value={summary.phaseConvention} />
          <FieldRow
            label="Shared style preset"
            value="one shared eigen/response mode visualization preset; switching modes keeps color, shader, vector, phase, and colormap controls"
          />
          <FieldRow
            label="Volume inspection roadmap"
            value="clip planes and shader opacity remain planned for internal-mode inspection"
          />
          <FrequencyDomainModeDisplayControls
            disabled={!summary.fieldId}
            labelPrefix="Eigen mode"
            settings={modeDisplaySettings}
            viewDefaultValue={summary.defaultView}
            viewOptions={summary.availableViewValues}
          />
          <EigenMode3DActions summary={summary} />
        </InspectorSection>
      </div>
    );
  };
EigenModeInspectorPanel.displayName = "EigenModeInspectorPanel";

function EigenMode3DActions({
  summary,
}: {
  summary: ReturnType<typeof useEigenModeSummary>;
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
    if (!summary.fieldId) return;
    const animate = view === "animate";
    void kernel.commands.execute(
      animate
        ? "analysis.frequency-domain.set-3d-animation"
        : "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
      {
        animatePhase: animate ? true : undefined,
        animationRateHz: animate ? 1 : undefined,
        fieldId: summary.fieldId,
        label: summary.modeIdentity,
        phaseRad: 0,
        source: "eigen-mode",
        view: animate ? "phase_rotated_real" : view,
      },
    );
  };
  const stopAnimation = (): void => {
    if (!summary.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.set-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
      {
        animatePhase: false,
        animationRateHz: 0,
        fieldId: summary.fieldId,
        label: summary.modeIdentity,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const disabled = !summary.fieldId;
  const actions = [
    {
      icon: RotateCw,
      label: "Rotated",
      title: "Plot selected eigen mode with phase-rotated real display",
      variant: "primary" as const,
      view: "phase_rotated_real" as const,
    },
    {
      icon: Activity,
      label: "Real",
      title: "Plot selected eigen mode real component",
      variant: "secondary" as const,
      view: "real" as const,
    },
    {
      icon: Activity,
      label: "Imag",
      title: "Plot selected eigen mode imaginary component",
      variant: "secondary" as const,
      view: "imag" as const,
    },
    {
      icon: Activity,
      label: "Abs",
      title: "Plot selected eigen mode complex magnitude",
      variant: "secondary" as const,
      view: "abs" as const,
    },
    {
      icon: RotateCw,
      label: "Phase",
      title: "Plot selected eigen mode phase",
      variant: "secondary" as const,
      view: "phase" as const,
    },
    {
      icon: Play,
      label: "Animate",
      title: "Animate selected eigen mode phase in 3D",
      variant: "secondary" as const,
      view: "animate" as const,
    },
  ];

  return (
    <div
      aria-label="Selected eigen mode 3D visualization controls"
      className="fm-frequency-domain-visualization-actions"
    >
      {actions.map((entry) => {
        const Icon = entry.icon;
        return (
          <Button
            aria-label={entry.title}
            className="fm-inspector-action-button"
            disabled={disabled}
            key={entry.view}
            size="sm"
            title={disabled ? "Mode field payload is missing" : entry.title}
            type="button"
            variant={entry.variant}
            onClick={() => plot(entry.view)}
          >
            <Icon aria-hidden="true" size={13} />
            <span>{entry.label}</span>
          </Button>
        );
      })}
      <Button
        aria-label="Stop selected eigen mode animation"
        className="fm-inspector-action-button"
        disabled={disabled}
        size="sm"
        title={
          disabled
            ? "Mode field payload is missing"
            : "Stop selected eigen mode animation"
        }
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

export function FrequencyResponsePointInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponsePointSummary(props);
  const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
    sourceDetail: "results.frequency_response.frequency_point",
  });

  return (
    <div data-inspector-surface="frequency-response-point">
      <InspectorSection
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
      </InspectorSection>
      <InspectorSection
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
          disabled={!summary.fieldId}
          labelPrefix="Response point"
          settings={modeDisplaySettings}
          viewDefaultValue={summary.defaultView}
          viewOptions={summary.availableViewValues}
        />
        <FrequencyResponsePoint3DActions summary={summary} />
      </InspectorSection>
    </div>
  );
}

function FrequencyResponsePoint3DActions({
  summary,
}: {
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
    if (!summary.fieldId) return;
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
        label: summary.frequencyDisplay,
        phaseRad: summary.defaultPhaseRad,
        source: "frequency-response",
        view: animate ? "phase_rotated_real" : view,
      },
    );
  };
  const stopAnimation = (): void => {
    if (!summary.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.set-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_point",
      }),
      {
        animatePhase: false,
        animationRateHz: 0,
        fieldId: summary.fieldId,
        label: summary.frequencyDisplay,
        phaseRad: summary.defaultPhaseRad,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };
  const disabled = !summary.fieldId;
  const actions = [
    {
      icon: RotateCw,
      label: "Rotated",
      title: "Plot response field with phase-rotated real display",
      variant: "primary" as const,
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
        return (
          <Button
            aria-label={entry.title}
            className="fm-inspector-action-button"
            disabled={disabled}
            key={entry.view}
            size="sm"
            title={disabled ? "Response field payload is missing" : entry.title}
            type="button"
            variant={entry.variant}
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
        title={disabled ? "Response field payload is missing" : "Stop response field animation"}
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
      {
        fieldId: point.fieldId,
        label: `response ${formatFrequency(point.frequencyHz)}`,
        phaseRad: 0,
        source: "frequency-response",
        view: action,
      },
    );
  };

  return (
    <div data-inspector-surface="frequency-response-frequency-points">
      <InspectorSection
        title="Response Frequency Points Table"
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
        <FieldRow label="Field overlays" value={summary.fieldOverlays} />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
        <FieldRow label="3D workflow" value={summary.workflow} />
      </InspectorSection>
      <InspectorSection
        title="Response Frequency Point Table"
        badge={summary.badge}
      >
        <FrequencyDomainResponsePointTable
          onPlotResponsePoint={plotPoint}
          points={summary.responseModel.points}
        />
      </InspectorSection>
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
      <InspectorSection title="Response Sweep Progress" badge={summary.badge}>
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Complete" value={summary.complete} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
        <FieldRow label="Reason" value={summary.reason} />
      </InspectorSection>
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
      <InspectorSection
        title="Response Sweep Cancellation"
        badge={summary.badge}
      >
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Complete" value={summary.complete} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
        <FieldRow label="Reason" value={summary.reason} />
      </InspectorSection>
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
      <InspectorSection
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
        <FieldRow label="Field overlays" value={summary.fieldOverlayStatus} />
        <FieldRow label="Chart series" value={summary.chartSeriesStatus} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency Response Observables"
        badge={summary.seriesStatus}
      >
        <FieldRow label="Observable series" value={summary.seriesStatus} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Frequency points" value={summary.pointCount} />
        <FieldRow label="Field overlays" value={summary.fieldOverlayStatus} />
        <FieldRow label="Peak response" value={summary.peakResponse} />
      </InspectorSection>
    </div>
  );
}

export function FrequencyResponseSweepInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFrequencyResponseSweepSummary();
  const kernel = useKernel();
  const plotPoint = (point: FrequencyResponsePoint): void => {
    if (!point.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.sweep",
      }),
      {
        fieldId: point.fieldId,
        label: `response ${formatFrequency(point.frequencyHz)}`,
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="frequency-response-sweep">
      <InspectorSection
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
        <FieldRow label="Field overlays" value={summary.fieldOverlayStatus} />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
      </InspectorSection>
      <InspectorSection title="Driven Response Chart" badge={summary.badge}>
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={plotPoint}
        />
      </InspectorSection>
      <InspectorSection
        title="Driven Response Point Table"
        badge={summary.badge}
      >
        <FrequencyDomainResponsePointTable
          onPlotResponsePoint={(point, action) => {
            if (!point.fieldId) return;
            void kernel.commands.execute(
              "analysis.frequency-response.plot-response-field-3d",
              createCommandContext("inspector", kernel, {
                sourceDetail: "results.frequency_response.sweep",
              }),
              {
                fieldId: point.fieldId,
                label: `response ${formatFrequency(point.frequencyHz)}`,
                phaseRad: 0,
                source: "frequency-response",
                view: action,
              },
            );
          }}
          points={summary.responseModel.points}
        />
      </InspectorSection>
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
      <InspectorSection
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
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Response artifact" value={summary.responseArtifact} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
      </InspectorSection>
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
      <InspectorSection title="Frequency-Domain Job Queue" badge={summary.badge}>
        <FieldRow label="Stage run" value={summary.stageRun} />
        <FieldRow label="Eigen samples" value={summary.eigenSamples} />
        <FieldRow label="Response frequencies" value={summary.responseFrequencies} />
        <FieldRow label="Response progress" value={summary.responseProgress} />
        <FieldRow label="Cancel checkpoint" value={summary.cancelCheckpoint} />
        <FieldRow label="Artifact export" value={summary.artifactExport} />
      </InspectorSection>
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
      <InspectorSection
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
      </InspectorSection>
    </div>
  );
}

export function EigenSampleJobInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useEigenSampleJobSummary();

  return (
    <div data-inspector-surface="eigen-sample-job">
      <InspectorSection title="Eigen k-Sample Job" badge={summary.badge}>
        <FieldRow label="k-path samples" value={summary.kPathSamples} />
        <FieldRow label="Branch tracking" value={summary.branchTracking} />
        <FieldRow label="Mode fields" value={summary.modeFields} />
        <FieldRow label="Solver lane" value={summary.solverLane} />
        <FieldRow label="Output resources" value={summary.outputResources} />
      </InspectorSection>
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
      <InspectorSection
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
      </InspectorSection>
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
      <InspectorSection
        title="Response Sweep Progress Job"
        badge={summary.badge}
      >
        <FieldRow label="Progress resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Runtime state" value={summary.runtimeState} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
      </InspectorSection>
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
      <InspectorSection
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
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Diagnostics Overview"
        badge={summary.badge}
      >
        <FieldRow label="Capability gates" value={summary.capabilityGates} />
        <FieldRow label="Solver state" value={summary.solverState} />
        <FieldRow label="Artifacts" value={summary.artifacts} />
        <FieldRow label="API resources" value={summary.apiResources} />
        <FieldRow label="Visualization" value={summary.visualization} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Capability Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Modal lane" value={summary.modalLane} />
        <FieldRow label="Driven lane" value={summary.drivenLane} />
        <FieldRow label="Boundary gates" value={summary.boundaryGates} />
        <FieldRow label="Demag gates" value={summary.demagGates} />
        <FieldRow label="Visualization gates" value={summary.visualizationGates} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Equilibrium Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Equilibrium source" value={summary.source} />
        <FieldRow label="Stage kind" value={summary.stageKind} />
        <FieldRow label="Modal readiness" value={summary.modalReadiness} />
        <FieldRow label="Response readiness" value={summary.responseReadiness} />
        <FieldRow label="Tangent contract" value={summary.tangentContract} />
      </InspectorSection>
    </div>
  );
}

export function FrequencyDomainOperatorDiagnosticInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyDomainOperatorDiagnosticSummary();

  return (
    <div data-inspector-surface="frequency-domain-operator-diagnostic">
      <InspectorSection
        title="Frequency-Domain Operator Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Operator family" value={summary.operatorFamily} />
        <FieldRow label="Normalization" value={summary.normalization} />
        <FieldRow label="Phase convention" value={summary.phaseConvention} />
        <FieldRow label="Demag-k gate" value={summary.demagKGate} />
        <FieldRow label="Boundary policy" value={summary.boundaryPolicy} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Solver Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Execution lane" value={summary.executionLane} />
        <FieldRow label="Response residuals" value={summary.responseResiduals} />
        <FieldRow label="Modal residuals" value={summary.modalResiduals} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Cancel state" value={summary.cancelState} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Artifact Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Manifest" value={summary.manifest} />
        <FieldRow label="Modal spectrum" value={summary.modalSpectrum} />
        <FieldRow label="Modal branches" value={summary.modalBranches} />
        <FieldRow label="Modal dispersion" value={summary.modalDispersion} />
        <FieldRow label="Driven sweep" value={summary.drivenSweep} />
        <FieldRow label="Field payloads" value={summary.fieldPayloads} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain API Resource Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Manifest endpoint" value={summary.manifestEndpoint} />
        <FieldRow label="Spectrum endpoint" value={summary.spectrumEndpoint} />
        <FieldRow label="Response sweep endpoint" value={summary.responseEndpoint} />
        <FieldRow
          label="Response progress endpoint"
          value={summary.progressEndpoint}
        />
        <FieldRow label="Field endpoint" value={summary.fieldEndpoint} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Visualization Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Mode overlays" value={summary.modeOverlays} />
        <FieldRow label="Response overlays" value={summary.responseOverlays} />
        <FieldRow label="Chart readiness" value={summary.chartReadiness} />
        <FieldRow label="Animation" value={summary.animation} />
        <FieldRow label="Viewport handoff" value={summary.viewportHandoff} />
      </InspectorSection>
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
      <InspectorSection
        title="Periodic/Floquet Pair Resource"
        badge={summary.badge}
      >
        <FieldRow label="Resource endpoint" value={MESHING_PERIODIC_PAIRS_PATH} />
        <FieldRow label="Pair count" value={summary.pairCount} />
        <FieldRow label="Representative pair" value={summary.representativePair} />
        <FieldRow label="Max residual" value={summary.maxResidual} />
        <FieldRow label="Invalid pairs" value={summary.invalidPairs} />
      </InspectorSection>
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
      <InspectorSection
        title="Periodic/Floquet Diagnostics"
        badge={summary.badge}
      >
        <FieldRow label="Periodic pairs" value={summary.periodicPairs} />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
        <FieldRow label="Dynamic demag-k" value={summary.dynamicDemagK} />
        <FieldRow label="Phase convention" value={summary.phaseConvention} />
        <FieldRow label="Mesh residual" value={summary.meshResidual} />
      </InspectorSection>
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
      <InspectorSection title="Frequency-Domain Resource Family" badge="resources">
        <FieldRow label="Manifest resource" value={summary.manifestResource} />
        <FieldRow label="Available resources" value={summary.availableResources} />
        <FieldRow label="Modal artifacts" value={summary.modalArtifacts} />
        <FieldRow label="Driven artifacts" value={summary.drivenArtifacts} />
        <FieldRow label="Field payloads" value={summary.fieldPayloads} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency-Domain Manifest Resource"
        badge={summary.schema}
      >
        <FieldRow label="Schema" value={summary.schema} />
        <FieldRow label="Resource endpoint" value={summary.resourceEndpoint} />
        <FieldRow label="Artifact" value={summary.artifact} />
        <FieldRow label="Physics contract" value={summary.physicsContract} />
        <FieldRow label="Stage kind" value={summary.stageKind} />
      </InspectorSection>
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
      <InspectorSection title="Eigen Spectrum Resource" badge={summary.badge}>
        <FieldRow label="Resource endpoint" value={summary.spectrumResource} />
        <FieldRow
          label="Mode rows"
          value={`${summary.modeCount} mode(s), ${summary.fieldOverlayCount} field overlay(s)`}
        />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
      </InspectorSection>
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
      <InspectorSection title="Eigen Mode Field Resource" badge={summary.modeFields}>
        <FieldRow
          label="Field payload contract"
          value="phase-rotated real / real / imag / abs / phase"
        />
        <FieldRow label="Mode fields" value={summary.modeFields} />
        <FieldRow label="Output resources" value={summary.outputResources} />
        <FieldRow label="Viewport handoff" value="mode selection -> 3D overlay" />
      </InspectorSection>
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
      <InspectorSection
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
      </InspectorSection>
    </div>
  );
}

export function FrequencyResponseProgressResourceInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseFrequencyPointsSummary();

  return (
    <div data-inspector-surface="frequency-response-progress-resource">
      <InspectorSection
        title="Frequency Response Progress Resource"
        badge={summary.progressState}
      >
        <FieldRow
          label="Progress endpoint"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH}
        />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
        <FieldRow label="Field overlays" value={summary.fieldOverlays} />
      </InspectorSection>
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
      <InspectorSection
        title="Frequency Response Field Resource"
        badge={summary.fieldOverlays}
      >
        <FieldRow
          label="Field endpoint"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH}
        />
        <FieldRow label="Response fields" value={summary.fieldOverlays} />
        <FieldRow label="3D workflow" value={summary.workflow} />
      </InspectorSection>
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
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(responseSweep.data);
  const peakModel = buildFmrPeakTableModel({
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const comparisonModel = buildFmrModalDrivenComparisonModel({
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
  const capabilities = record(manifest.data?.capabilities);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const modalReferenceCpu = capabilityStatus(modalCapabilities?.reference_cpu);
  const responseMagneticCpu = capabilityStatus(responseCapabilities?.magnetic_cpu);
  const spectrumResource = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;
  const responseResource = ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;

  return {
    activeChartRoute: `${chartRoute.mode} -> ${chartRoute.primaryChart}`,
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
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifest.data?.result_manifest?.payload,
  );
  const peakModel = buildFmrPeakTableModel({
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const capabilities = record(manifest.data?.capabilities);
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
    modalVisualization: `${modalFieldCount} mode field overlay(s)`,
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
  const dispersionModel = buildEigenDispersionChartModel(dispersion.data);
  const capabilities = record(manifest.data?.capabilities);
  const modalCapabilities = record(capabilities?.modal);
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
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; k_path: ${capabilityStatus(dispersionCapabilities?.k_path)}`,
    dispersion: `${dispersionModel.points.length} k-path point(s), ${branchesModel.branches.length} branch(es)`,
    frequencyCoverage: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    handoff: "select mode or branch point -> plot mode field",
    spectrum: `${spectrumModel.points.length} mode(s), ${modalFieldCount} field overlay(s)`,
  };
}

function useEigenStudySummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const physics = record(manifestPayload?.physics);
  const capabilities = record(manifest.data?.capabilities);
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const capabilities = record(manifest.data?.capabilities);
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const capabilities = record(manifest.data?.capabilities);
  const responseCapabilities = record(capabilities?.response);
  const magneticCpuCapability = record(responseCapabilities?.magnetic_cpu);
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
    executionLane:
      stringValue(magneticCpuCapability?.reason)?.replace(/ available$/, "") ??
      "native MFEM CPU gamma/free-boundary response",
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const comparisonModel = buildFmrModalDrivenComparisonModel({
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
        ? "both overlays ready"
        : modalPeak?.fieldId
          ? "modal overlay ready"
          : drivenPeak?.fieldId
            ? "driven overlay ready"
            : "overlays missing",
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
  };
}

function useFrequencyDomainProvenanceSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

function useFrequencyDomainDispersionSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const dispersionModel = buildEigenDispersionChartModel(dispersion.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const capabilities = record(manifest.data?.capabilities);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const boundaryCapabilities = record(capabilities?.boundary);
  const frequencies = dispersionModel.points.map((point) => point.frequencyHz);
  const pathValues = dispersionModel.points.map((point) => point.pathS);
  const primaryBranch = branchesModel.branches[0] ?? null;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );

  return {
    badge:
      dispersion.status === "ready"
        ? `${dispersionModel.points.length} point(s)`
        : dispersion.status,
    branchCount: branchesModel.branches.length,
    capabilitySummary: `k_path: ${capabilityStatus(dispersionCapabilities?.k_path)}; branch_tracking: ${capabilityStatus(dispersionCapabilities?.branch_tracking)}`,
    branchesModel,
    dispersionPointCount: dispersionModel.points.length,
    dispersionModel,
    dispersionResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    dispersionSeriesCount: dispersionModel.series.length,
    floquetGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    frequencyRange: formatFrequencyRange(frequencies),
    kPathSpan: `${formatNumberRange(pathValues)} rad/m`,
    modalOverlays: `${spectrumModel.points.filter((point) => point.modeFieldId).length} mode field(s) available from modal spectrum`,
    primaryBranch: primaryBranch
      ? `${primaryBranch.label ?? primaryBranch.branchId}; ${formatFrequencyRange(
          primaryBranch.points.map((point) => point.frequencyRealHz),
        )}`
      : "not available",
    trackedPointCount,
  };
}

function useEigenDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(dispersion.data);
  const capabilities = record(manifest.data?.capabilities);
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

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    branchDiagnostics: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    capabilitySummary: `k_path: ${capabilityStatus(dispersionCapabilities?.k_path)}; branch_tracking: ${capabilityStatus(dispersionCapabilities?.branch_tracking)}`,
    demagKGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    dispersionSamples: `${dispersionModel.points.length} point(s), ${dispersion.status}`,
    modalAvailability: `${studyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    modalSpectrum: `${spectrumModel.points.length} mode(s), ${fieldOverlayCount} field overlay(s)`,
    residualCoverage: `${residualCount}/${spectrumModel.points.length} mode(s)`,
  };
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

function useEigenBranchSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const branchId = ref?.branchId ?? branchIdFromNodeId(selection.nodeId);
  const branches = useFrequencyDomainEigenBranchesResource();
  const branchesModel = buildEigenBranchesModel(branches.data);
  const branch =
    branchesModel.branches.find((candidate) => candidate.branchId === branchId) ??
    branchesModel.branches[0] ??
    null;
  const sampleValues = branch?.points.map((point) => point.sampleIndex) ?? [];
  const representativePoint = branch?.points[0] ?? null;

  return {
    badge: branch ? `${branch.points.length} point(s)` : branches.status,
    branch,
    branchIdentity: branch
      ? `${branch.branchId}; ${branch.label ?? "unlabeled"}`
      : "not available",
    branchResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    chartBadge: branch ? `${branch.points.length} sample(s)` : branches.status,
    continuity: branch
      ? `min overlap ${formatCompactNumberOrUnavailable(branch.overlapPrevMin)}; min confidence ${formatCompactNumberOrUnavailable(branch.trackingConfidenceMin)}`
      : "not available",
    frequencyRange: branch
      ? formatFrequencyRange(branch.points.map((point) => point.frequencyRealHz))
      : "not available",
    handoff: representativePoint
      ? "open representative mode and plot its field overlay"
      : "requires mode field metadata",
    representativeMode: representativePoint
      ? `sample ${representativePoint.sampleIndex}, mode ${representativePoint.rawModeIndex}, ${formatFrequency(representativePoint.frequencyRealHz)}`
      : "not available",
    sampleTableBadge: branch ? `${branch.points.length} row(s)` : branches.status,
    trackedPoints:
      branch && sampleValues.length
        ? `${branch.points.length} point(s); samples ${Math.min(
            ...sampleValues,
          )}-${Math.max(...sampleValues)}`
        : "not available",
  };
}

function branchIdFromNodeId(nodeId: string | null): string | null {
  if (!nodeId) return null;
  const marker = ":branch:";
  const markerIndex = nodeId.lastIndexOf(marker);
  return markerIndex >= 0 ? nodeId.slice(markerIndex + marker.length) : null;
}

function useEigenSpectrumSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const capabilities = record(manifest.data?.capabilities);
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

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; mode_field_payload: ${capabilityStatus(modalCapabilities?.mode_field_payload)}`,
    dampingCoverage: `${dampingCount}/${spectrumModel.points.length} mode(s)`,
    fieldOverlayCount,
    frequencyRange: formatFrequencyRange(frequencies),
    modeCount: spectrumModel.points.length,
    primaryMode: primaryMode
      ? `mode ${primaryMode.rawModeIndex} at ${formatFrequency(primaryMode.frequencyHz)}`
      : "not available",
    residualCoverage: `${residualCount}/${spectrumModel.points.length} mode(s)`,
    spectrumModel,
    spectrumResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  };
}

function useFrequencyDomainResponseMapSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const capabilities = record(manifest.data?.capabilities);
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
  const responseMapSupported =
    manifest.data?.floquet_nonzero_k_response_supported === true;

  return {
    availability: responseMapSupported ? "ready" : "unsupported",
    badge: responseMapSupported ? "ready" : "unsupported",
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
    uiFallback: responseMapSupported
      ? "show response map controls"
      : "show FMR response sweep until nonzero-k map is executable",
  };
}

function useEigenModesSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const capabilities = record(manifest.data?.capabilities);
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
    modeTable: `${modeCount} mode(s), ${overlayReadyCount} overlay-ready`,
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
    manifest.data?.result_manifest?.payload,
  );
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
          } overlay-ready`
        : "no modal spectrum loaded",
    modalWorkflows: modalRows.map((row) => row.mode).join(", "),
    modeRows,
    primaryChart: chartRoute.primaryChart,
    requiredArtifacts: activeRow.artifacts,
    responseMapGate: responseMapRow?.capabilityStatus ?? "not available",
  };
}

function useEigenModeSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const sampleIndex = ref?.sampleIndex ?? null;
  const modeIndex = ref?.modeIndex ?? null;
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const eigenMode = useFrequencyDomainEigenModeResource(sampleIndex, modeIndex);
  const fieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    sampleIndex,
    modeIndex,
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const spectrumPoint = spectrumModel.points.find(
    (point) =>
      point.sampleIndex === sampleIndex && point.rawModeIndex === modeIndex,
  );
  const modePayload = record(eigenMode.data);
  const componentSummary = record(modePayload?.component_summary);
  const frequencyHz =
    finiteNumber(modePayload?.frequency_real_hz) ??
    spectrumPoint?.frequencyHz ??
    null;
  const imaginaryFrequencyHz =
    finiteNumber(modePayload?.frequency_imag_hz) ??
    spectrumPoint?.imaginaryFrequencyHz ??
    null;
  const angularFrequency = finiteNumber(modePayload?.angular_frequency_rad_per_s);
  const residual =
    finiteNumber(modePayload?.residual_norm) ??
    spectrumPoint?.residualNorm ??
    null;
  const tangentLeakage =
    finiteNumber(modePayload?.tangent_leakage_max_abs) ??
    spectrumPoint?.tangentLeakageMax ??
    null;
  const fieldId =
    ref?.fieldId ??
    fieldMeta.data?.field_id ??
    spectrumPoint?.modeFieldId ??
    null;
  const fieldResource =
    ref?.resourceRef ??
    fieldMeta.data?.resource_key ??
    spectrumPoint?.modeFieldResourceKey ??
    null;
  const availableViews = fieldMeta.data?.available_views ?? [];
  const defaultView = fieldMeta.data?.default_view ?? availableViews[0] ?? null;
  const dominantPolarization = stringValue(modePayload?.dominant_polarization);
  const realSamples = finiteNumber(componentSummary?.real_sample_count);
  const imagSamples = finiteNumber(componentSummary?.imag_sample_count);
  const fieldMetaRecord = record(fieldMeta.data);
  const phaseConvention =
    stringValue(record(fieldMetaRecord?.field_units)?.phase_convention) ??
    stringValue(record(modePayload?.metadata)?.phase_convention) ??
    "exp(-i omega t)";

  return {
    actionBadge: fieldId ? "3D overlay ready" : "field missing",
    angularFrequency:
      angularFrequency == null
        ? "not available"
        : `${formatNumber(angularFrequency)} rad/s`,
    availableViews: availableViews.length ? availableViews.join(", ") : "not available",
    availableViewValues: normalizedAnalysisFieldViewOptions(
      availableViews,
      defaultView,
    ),
    badge:
      sampleIndex == null || modeIndex == null
        ? "unselected"
        : eigenMode.status === "ready"
          ? `sample ${sampleIndex}, mode ${modeIndex}`
          : eigenMode.status,
    dominantPolarization: dominantPolarization ?? "not available",
    defaultView: normalizeAnalysisFieldView(defaultView),
    defaultViewLabel: defaultView ? analysisFieldViewLabel(defaultView) : "not available",
    fieldId,
    fieldIdLabel: fieldId ?? "not available",
    fieldResource: fieldResource ?? "not available",
    fieldStatus: fieldId ? `${fieldId}; overlay-ready` : "mode field missing",
    frequencyDisplay: formatFrequency(frequencyHz),
    imaginaryFrequency: formatFrequency(imaginaryFrequencyHz),
    modeIdentity:
      sampleIndex == null || modeIndex == null
        ? "not selected"
        : `sample ${sampleIndex}, mode ${modeIndex}`,
    phaseConvention,
    residual: formatNumberOrUnavailable(residual),
    tangentLeakageMax: formatNumberOrUnavailable(tangentLeakage),
    workflow:
      fieldId && availableViews.length
        ? `phasor reconstruction; ${realSamples ?? "?"} real samples, ${imagSamples ?? "?"} imag samples`
        : "field payload required for 3D phasor overlay",
  };
}

function useFmrPeakSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const peakIndex = ref?.fmrPeakIndex ?? null;
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const peakModel = buildFmrPeakTableModel({
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

  return {
    absorbedPowerDensity:
      peak?.absorbedPowerDensity == null
        ? "not available"
        : `${formatNumber(peak.absorbedPowerDensity)} W/m^3`,
    amplitude: formatNumberOrUnavailable(peak?.amplitude),
    actionBadge: peak?.fieldId ? "3D-ready" : "metadata",
    artifactFamily: isModal ? "eigen/spectrum.v2.json" : "response/magnetic-sweep",
    badge:
      peakIndex == null
        ? "unselected"
        : peak
          ? `peak ${peakIndex + 1}`
          : "missing",
    fieldId: peak?.fieldId ?? null,
    fieldPayload: peak?.fieldId ? `${peak.fieldId}; overlay-ready` : "missing",
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
      ? "field id is published; plot command can request the data-plane vector resource"
      : "field payload missing; 3D overlay is unavailable",
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
    manifest.data?.result_manifest?.payload,
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

  return {
    actionBadge: fieldId ? "3D overlay ready" : "field missing",
    absorbedPowerDensity:
      absorbedPowerDensity == null
        ? "not available"
        : `${formatNumber(absorbedPowerDensity)} W/m^3`,
    amplitude: formatNumberOrUnavailable(amplitude),
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
    defaultPhaseLabel: `${formatNumber(defaultPhaseRad)} rad`,
    defaultPhaseRad,
    defaultView: normalizeAnalysisFieldView(defaultView),
    defaultViewLabel: defaultView ? analysisFieldViewLabel(defaultView) : "not available",
    fieldId,
    fieldIdLabel: fieldId ?? "not available",
    fieldResource: fieldResource ?? "not available",
    fieldStatus: fieldId ? `${fieldId}; overlay-ready` : "field artifact missing",
    frequencyDisplay: formatFrequency(frequencyHz),
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
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
    amplitudeRange: formatNumberRange(amplitudes),
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
    workflow: "select frequency point -> inspect response field overlay in 3D",
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
    manifest.data?.result_manifest?.payload,
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
    fieldOverlayStatus: `${fieldOverlayCount}/${points.length} point(s) overlay-ready`,
    frequencyRange: formatFrequencyRange(frequencies),
    maxAbsorbedPowerDensity: maxFinite(absorbedPowers) == null
      ? "not available"
      : `${formatNumber(maxFinite(absorbedPowers)!)} W/m^3`,
    meanAmplitude: meanFinite(amplitudes) == null
      ? "not available"
      : formatNumber(meanFinite(amplitudes)!),
    observableId: observableId ?? "not selected",
    peakAmplitude: maxFinite(amplitudes) == null
      ? "not available"
      : formatNumber(maxFinite(amplitudes)!),
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
    manifest.data?.result_manifest?.payload,
  );
  const fmrPeakModel = buildFmrPeakTableModel({
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
    fieldOverlayStatus: `${fieldOverlayCount}/${responseModel.points.length} point(s) overlay-ready`,
    frequencyRange: formatFrequencyRange(frequencies),
    maxAbsorbedPowerDensity: maxFinite(absorbedPowers) == null
      ? "not available"
      : `${formatNumber(maxFinite(absorbedPowers)!)} W/m^3`,
    peakResponse: peak
      ? `${formatFrequency(peak.frequencyHz)}; amplitude ${formatNumberOrUnavailable(peak.amplitude)}`
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
    seriesStatus: responseModel.series.length
      ? `${responseModel.series.length} series: ${responseModel.series.map((series) => series.label).join(", ")}`
      : "not available",
    absorbedPowerCoverage: `${absorbedPowers.length}/${responseModel.points.length} point(s)`,
    susceptibilityComponent: "max |χ| from response tensor",
  };
}

function useFrequencyResponseDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const response = manifest.data?.response;
  const studyKind = response?.study_kind ?? "frequency_response";
  const capabilities = record(manifest.data?.capabilities);
  const responseCapabilities = record(capabilities?.response);
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;
  const residualCount = responseModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;

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
      ? `${cancelSummary.runtimeState}; ${cancelSummary.progress}; partial artifacts ${cancelSummary.partialArtifacts}`
      : "not requested",
    eigenSamples: eigenSummary.kPathSamples,
    responseFrequencies: responseSummary.frequencyWorkUnits,
    responseProgress: `${progressSummary.runtimeState}; ${progressSummary.progress}; written ${progressSummary.writtenArtifacts}`,
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
  const dispersionModel = buildEigenDispersionChartModel(dispersion.data);
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
    modeFields: `${modeFieldCount} overlay-ready`,
    outputResources: `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH}; ${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH}`,
    solverLane: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
  };
}

function useFrequencyResponseFrequencyJobSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
      ? `${cancelSummary.runtimeState}; ${cancelSummary.progress}`
      : "not requested",
    fieldArtifacts: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    frequencyWorkUnits: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
    residualCoverage: `${residualCount}/${responseModel.points.length} point(s)`,
    solverLane: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}`,
    sweepProgress: `${progressSummary.runtimeState}; ${progressSummary.progress}`,
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
  const capabilities = record(manifest.data?.capabilities);
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const physics = record(manifestPayload?.physics);
  const capabilities = record(manifest.data?.capabilities);
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
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
  const capabilities = record(manifest.data?.capabilities);
  const responseCapabilities = record(capabilities?.response);
  const magneticCpuCapability = record(responseCapabilities?.magnetic_cpu);

  return {
    badge: responseSweep.status,
    cancelState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    executionLane:
      stringValue(magneticCpuCapability?.reason)?.replace(/ available$/, "") ??
      "native MFEM CPU gamma/free-boundary response",
    modalResiduals: `${modalResidualCount}/${spectrumModel.points.length} mode(s)`,
    progress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    responseResiduals: `${responseResidualCount}/${responseModel.points.length} point(s)`,
  };
}

function useFrequencyDomainApiResourceDiagnosticSummary() {
  return {
    badge: "resource-first",
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
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
    modeOverlays: `${modeFieldCount} mode field overlay(s)`,
    responseOverlays: `${responseFieldCount} response field artifact(s)`,
    viewportHandoff: "selection -> command registry -> unified viewport overlay",
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
    latest_artifact_manifest_path?: string | null;
    missing_reason?: string | null;
    partial_artifacts_available?: boolean | null;
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
  const runtimeState = data
    ? `${data.state ?? data.status ?? status}`
    : status;

  return {
    badge: runtimeState,
    complete: data?.complete === true ? "yes" : data?.complete === false ? "no" : "unknown",
    currentFrequency: formatFrequency(data?.current_frequency_hz ?? null),
    latestManifest: data?.latest_artifact_manifest_path ?? "not available",
    partialArtifacts:
      data?.partial_artifacts_available === true
        ? "yes"
        : data?.partial_artifacts_available === false
          ? "no"
          : "unknown",
    progress,
    reason: data?.missing_reason ?? "none",
    resourceKey,
    runtimeState,
    status: data?.status ?? status,
    writtenArtifacts:
      data?.written_frequency_point_artifacts == null
        ? "not available"
        : String(data.written_frequency_point_artifacts),
  };
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
    badge: periodicPairs.status,
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
  const manifestPayload = record(manifest.data?.result_manifest?.payload);
  const spinWaveBc = record(manifestPayload?.spin_wave_bc);
  const capabilities = record(manifest.data?.capabilities);
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

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatNumberOrUnavailable(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : formatNumber(value);
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

function formatPowerDensity(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : `${formatCompactNumberOrUnavailable(value)} W/m^3`;
}

function formatMaxAbsSusceptibility(
  values: readonly number[] | null | undefined,
): string {
  if (!values?.length) return "not available";
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) return "not available";
  return formatCompactNumberOrUnavailable(
    Math.max(...finiteValues.map((value) => Math.abs(value))),
  );
}

function formatCompactNumberOrUnavailable(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${Number(value.toPrecision(6))}`;
}

function formatCompactNumberOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Number(value.toPrecision(6))}`;
}

function formatResidual(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(2);
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
