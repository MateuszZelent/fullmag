"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StudyProgressBar } from "../StudyProgressBar";
import { MESHING_PERIODIC_PAIRS_PATH } from "@/kernel/api/apiPaths";
import { useFrequencyDomainManifestResource } from "@/kernel/resources/studyRuntimeResources";
import { frequencyDomainManifestPayload } from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  useFrequencyDomainResourceFamilySummary,
  useFrequencyDomainManifestResourceSummary,
  useFrequencyDomainRunSummary,
  useFrequencyDomainExportsSummary,
} from "./frequencyDomainEigenFmrSummaries";
import {
  useFrequencyResponseProgressSummary,
  useFrequencyDomainJobsSummary,
  useEigenSampleJobSummary,
  useFrequencyResponseFrequencyJobSummary,
  useFrequencyDomainDiagnosticsSummary,
  useFrequencyDomainCapabilitiesDiagnosticSummary,
  useFrequencyDomainEquilibriumDiagnosticSummary,
  useFrequencyDomainOperatorDiagnosticSummary,
  useFrequencyDomainSolverDiagnosticSummary,
  useFrequencyDomainApiResourceDiagnosticSummary,
  useFrequencyDomainVisualizationDiagnosticSummary,
  useFrequencyDomainPeriodicPairsSummary,
  useFrequencyDomainPeriodicFloquetSummary,
} from "./frequencyDomainResponseSummaries";
import {
  record,
} from "./frequencyDomainResultFormatting";

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
