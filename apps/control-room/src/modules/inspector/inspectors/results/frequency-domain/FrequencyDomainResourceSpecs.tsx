"use client";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import { StudyProgressBar } from "../../../panels/StudyProgressBar";
import {
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
} from "@/kernel/api/apiPaths";
import { EigenModeInspectorPanel } from "../../../panels/frequency-domain/EigenModeInspectorPanel";
import {
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
} from "../../../panels/frequency-domain/FrequencyResponseInspectorPanels";
import { useEigenSpectrumSummary } from "../../../panels/frequency-domain/frequencyDomainEigenFmrSummaries";
import {
  useFrequencyResponseFrequencyPointsSummary,
  useFrequencyResponseProgressSummary,
  useFrequencyResponseSweepSummary,
  useEigenSampleJobSummary,
} from "../../../panels/frequency-domain/frequencyDomainResponseSummaries";
import { FrequencyDomainCalculationModesInspectorPanel } from "./FrequencyDomainOverviewSpecs";
import { FmrOverviewInspectorPanel } from "./FrequencyDomainFmrSpecs";
import {
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
} from "./FrequencyDomainEigenSpecs";

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
