"use client";

import { useState } from "react";
import { Activity, Eye } from "lucide-react";

import type { FrequencyDomainSweepProgressResource } from "@/kernel/api/apiTypes";
import { ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH } from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildFmrPeakTableModel,
  buildFrequencyResponseChartModel,
  buildFrequencyResponsePointSelectionRef,
  frequencyDomainManifestPayload,
  responseFieldResourcesFromManifest,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  FrequencyDomainResponseChart,
} from "../FrequencyDomainCharts";
import {
  FrequencyDomainFmrPeakTable,
  FrequencyDomainResponsePointTable,
  type FrequencyDomainResponsePointAction,
} from "../FrequencyDomainTables";
import {
  buildFmrResponseSweepViewModel,
  type FmrResponseProgressView,
} from "./FmrResponseSweepModel";

export function FmrResponseSweepInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFmrResponseSweepSummary();
  const kernel = useKernel();
  const [selectedFrequencyHz, setSelectedFrequencyHz] = useState<number | null>(
    null,
  );
  const view = buildFmrResponseSweepViewModel({
    peaks: summary.peaks,
    points: summary.responseModel.points,
    progress: summary.progress,
    resourceStatus: summary.resourceStatus,
    selectedFrequencyHz,
  });
  const drivenPeaks = view.peaks
    .filter((row) => row.peak.source === "driven_response")
    .map((row) => row.peak);

  const selectResponsePoint = (point: FrequencyResponsePoint): void => {
    setSelectedFrequencyHz(point.frequencyHz);
    const responseRef = buildFrequencyResponsePointSelectionRef(point, {
      calculationMode: "fmr_response",
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
    <div
      data-inspector-owner="frequency-domain.fmr-response"
      data-inspector-surface="fmr-response-sweep"
    >
      <InspectorGroup
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
          label="Response fields"
          value={`${summary.responseFieldCount} field artifacts`}
        />
        <FieldRow
          label="Driven peak status"
          value={`${drivenPeaks.length} driven peaks`}
        />
        <FieldRow
          label="Response series"
          value={`${summary.responseModel.series.length} chart series`}
        />
        <FieldRow
          label="3D handoff"
          value={`${summary.responseLinkedPointCount}/${summary.responsePointCount} frequency points are directly linked; ${summary.responseFieldCount} field payloads published`}
        />
        <FieldRow label="Response lifecycle" value={view.responseState} />
        <FieldRow
          label="Frequency axis"
          value={`${view.frequencyAxis.label} [${view.frequencyAxis.unit}]`}
        />
        <FieldRow
          label="Response axes"
          value={view.responseAxes
            .map((axis) => `${axis.label} [${axis.unit}]`)
            .join("; ")}
        />
        <FieldRow
          label="Selected frequency"
          value={
            view.selectedFrequencyHz == null
              ? "none"
              : formatFrequency(view.selectedFrequencyHz)
          }
        />
        <FieldRow
          label="Selected field handoff"
          value={
            view.canPlotSelectedFrequency
              ? "field-ready"
              : "unsupported until selected point has field payload"
          }
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Response Sweep Provenance"
        badge={view.responseState}
      >
        <FieldRow label="Resource status" value={summary.resourceStatus} />
        <FieldRow
          label="Progress"
          value={formatProgress(view.progress)}
        />
        <FieldRow
          label="Partial artifacts"
          value={view.progress?.partialArtifactsAvailable ? "yes" : "no"}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Response Sweep Chart"
        badge={`${summary.responseSeriesCount} series`}
      >
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={(point) => plotResponsePoint(point)}
          onSelectPoint={selectResponsePoint}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Response Point Browser"
        badge={`${summary.responsePointCount} point(s)`}
      >
        <FmrResponsePointBrowser
          onPlotResponsePoint={plotResponsePoint}
          onSelectResponsePoint={selectResponsePoint}
          points={summary.responseModel.points}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Response Point Table"
        badge={`${summary.responsePointCount} point(s)`}
      >
        <FrequencyDomainResponsePointTable
          onPlotResponsePoint={plotResponsePoint}
          points={summary.responseModel.points}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Driven FMR Peak Table"
        badge={`${drivenPeaks.length} peak(s)`}
      >
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotPeak}
          onSelectPeak={selectPeak}
          peaks={drivenPeaks}
        />
      </InspectorGroup>
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
            <Badge variant="secondary">
              {point.fieldId ? "3D-ready" : "field missing"}
            </Badge>
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
              value={point.fieldId ? "field-ready" : "missing"}
            />
          </div>
          <div className="fm-frequency-domain-response-card__actions">
            <Button
              aria-label={`Inspect response point ${point.frequencyIndex ?? index}`}
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
              aria-label={`Plot response point ${point.frequencyIndex ?? index} in 3D`}
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

function useFmrResponseSweepSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
  });
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const activeProgress =
    cancelRequested.data?.status === "cancel_requested"
      ? toProgressView(cancelRequested.data)
      : toProgressView(progress.data);
  const responseResource = ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;

  return {
    peaks: peakModel.peaks,
    progress: activeProgress,
    resourceStatus: responseSweep.status,
    responseBadge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    responseFieldCount,
    responseLinkedPointCount: responseModel.points.filter(
      (point) => point.fieldId,
    ).length,
    responseModel,
    responsePointCount: responseModel.points.length,
    responseResource,
    responseSeriesCount: responseModel.series.length,
  };
}

function toProgressView(
  data: FrequencyDomainSweepProgressResource | null | undefined,
): FmrResponseProgressView | null {
  if (!data) return null;
  return {
    complete: data.complete,
    completedFrequencyPoints: data.completed_frequency_points,
    currentFrequencyHz: data.current_frequency_hz ?? null,
    partialArtifactsAvailable: data.partial_artifacts_available,
    state: data.state,
    status: data.status,
    totalFrequencyPoints: data.total_frequency_points,
  };
}

function formatProgress(progress: FmrResponseProgressView | null): string {
  if (!progress) return "not available";
  return `${progress.status}; ${progress.completedFrequencyPoints}/${progress.totalFrequencyPoints} frequency points`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatNumberOrUnavailable(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : formatNumber(value);
}

function formatCompactNumberOrUnavailable(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${Number(value.toPrecision(6))}`;
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

function formatResidual(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(2);
  return `${Number(value.toPrecision(6))}`;
}

function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
