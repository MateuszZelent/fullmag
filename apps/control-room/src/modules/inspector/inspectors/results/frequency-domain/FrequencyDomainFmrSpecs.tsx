"use client";

import { EmptyState } from "@/shared/ui/EmptyState";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FmrPeakInspector } from "../../../panels/frequency-domain/FmrPeakInspector";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import { Activity, Eye } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
} from "@/kernel/api/apiPaths";
import {
  buildFrequencyResponsePointSelectionRef,
  eigenModeFieldAvailable,
  type EigenSpectrumPoint,
  type FmrPeakPoint,
  type FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { FrequencyDomainResponseChart, FrequencyDomainSpectrumChart } from "../../../panels/FrequencyDomainCharts";
import { FrequencyDomainFmrPeakTable } from "../../../panels/FrequencyDomainTables";
import { buildFrequencyResponsePlotCommandInput } from "../../../panels/frequency-domain/FrequencyResponseInspectorPanels.model";
import { useFmrResultSummary, useFmrPeakSummary } from "../../../panels/frequency-domain/frequencyDomainEigenFmrSummaries";
import {
  formatNumberOrUnavailable,
  formatFmrPeakSourceLabel,
  formatFmrPeakTarget,
  formatFmrPeakQualityFactor,
  formatPowerDensity,
  formatFrequency,
} from "../../../panels/frequency-domain/frequencyDomainResultFormatting";
import { FmrComparisonPairTable } from "./frequencyDomainShared";

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
        aria-label="Open the modal FMR spectrum inspector"
        className="fm-inspector-action-button"
        size="sm"
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
        aria-label="Open the driven FMR response sweep inspector"
        className="fm-inspector-action-button"
        size="sm"
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
        aria-label="Open the FMR peak table inspector"
        className="fm-inspector-action-button"
        size="sm"
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
        aria-label="Open the modal-vs-driven FMR comparison inspector"
        className="fm-inspector-action-button"
        size="sm"
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
      {keyedOccurrences(sortedPeaks, (peak) => JSON.stringify([
        peak.source,
        peak.frequencyHz,
        peak.frequencyPointIndex,
        peak.modeRef?.rawModeIndex,
      ])).map(({ item: peak, key }) => (
        <article
          className="fm-frequency-domain-peak-card"
          data-source={peak.source}
          data-status={peak.validationStatus}
          key={key}
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
              aria-label="Select this FMR peak"
              className="fm-inspector-action-button"
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onSelectPeak(peak)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Select</span>
            </Button>
            <Button
              aria-label="Plot this FMR peak field in 3D"
              className="fm-inspector-action-button"
              disabled={!peak.fieldId}
              disabledReason="This peak has no linked 3D field payload"
              size="sm"
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
        aria-label="Open source result surface"
        className="fm-inspector-action-button"
        size="sm"
        type="button"
        variant="secondary"
        onClick={openSourceInspector}
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open source result</span>
      </Button>
      <Button
        aria-label={linkedTargetLabel}
        className="fm-inspector-action-button"
        disabled={!summary.hasLinkedTarget}
        disabledReason="No linked mode or frequency point is recorded"
        size="sm"
        type="button"
        variant="secondary"
        onClick={openLinkedTarget}
      >
        <Eye size={13} aria-hidden="true" />
        <span>{linkedTargetLabel}</span>
      </Button>
      <Button
        aria-label="Plot linked field in 3D"
        className="fm-inspector-action-button"
        disabled={!summary.fieldId}
        disabledReason="This FMR peak has no linked field payload"
        size="sm"
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
