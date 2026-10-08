import { useMemo, useState } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { descriptorForFrequencyTable } from "@/shared/domain/analysis/analysisSurfaceDescriptor";
import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { sanitizeSelectedSeriesIds } from "@/shared/analysis-charts/chartSeriesSelection";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { ChartDisplayUnitControls } from "@/shared/analysis-charts/ChartDisplayUnitControls";
import {
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
  formatChartDisplayValue,
} from "@/shared/analysis-charts/chartScalePolicy";

import type { ChartSeries, ChartValueRange } from "../chartTableModel";
import {
  buildFrequencyDomainCursorSummary,
  buildFrequencyDomainWorkbenchSummary,
  buildFrequencyDomainWorkflowSummary,
  formatFrequencyDomainEmptyState,
  formatSeriesCount,
} from "../analysisWorkbenchModel";
import { frequencyDomainXAxisLabel } from "../frequencyDomainSeriesAdapter";
import { EChartsSurface } from "./EChartsSurface";
import { DispersionAxisControls } from "./DispersionAxisControls";
import { DispersionModeAction } from "./DispersionModeAction";
import { availableDispersionAxes, defaultDispersionAxis, projectDispersionSeries, type DispersionAxis } from "@/shared/domain/analysis/dispersionChartAxes";
import {
  type FmrModalDrivenComparisonModel,
  frequencyDomainResultTitle,
  type FrequencyDomainChartRoute,
  type FrequencyDomainResultContext,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { AnalysisFrequencyPresentationState } from "../hooks/useAnalysisFrequencyData";

const UNKNOWN_FREQUENCY_SOURCE_IDENTITY = {
  artifactPath: null,
  backend: null,
  contentDigest: null,
  device: null,
  precision: null,
  provenance: null,
  qualification: "unknown",
  runId: null,
  schemaVersion: null,
  stageId: null,
} as const;

export function AnalysisFrequencySurface({
  chartId,
  calculationMode,
  comparisonModel,
  context,
  displayUnits,
  descriptorId,
  kernel,
  onPointSelect,
  onRangeChange = () => undefined,
  onDisplayUnitsChange = () => undefined,
  onSelectedSeriesIdsChange,
  presentation,
  selectedSeriesIds,
  selectedPoint,
  series,
  range = null,
  status,
  title,
  unavailableReason,
}: {
  chartId?: string;
  calculationMode?: string;
  comparisonModel?: FmrModalDrivenComparisonModel;
  context?: FrequencyDomainResultContext;
  displayUnits?: Readonly<Record<string, string>>;
  descriptorId?: string;
  kernel: KernelApi;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  onDisplayUnitsChange?: (patch: Record<string, string>) => void;
  onSelectedSeriesIdsChange: (selectedSeriesIds: string[]) => void;
  presentation?: AnalysisFrequencyPresentationState;
  selectedSeriesIds: readonly string[];
  selectedPoint: AnalysisChartCursorPoint | null;
  series: readonly ChartSeries[];
  range?: ChartValueRange | null;
  status: string;
  title: string;
  unavailableReason: string | null;
}) {
  const physicalContext = context ?? presentation?.physicalContext;
  const qualifiedCalculationMode = physicalContext?.classification?.fmrQualified
    ? calculationMode
    : calculationMode === "fmr_modal"
      ? "free_modes"
      : calculationMode === "fmr_response"
        ? "frequency_response"
        : calculationMode;
  const descriptor = useMemo(
    () => descriptorForFrequencyTable(series[0]?.source.tableId ?? "frequency-domain"),
    [series],
  );
  const tableId = series[0]?.source.tableId ?? "frequency-domain";
  const isDispersion = tableId === "frequency-domain:eigen-dispersion";
  const datasetKey = `${physicalContext?.runId ?? series[0]?.sourceIdentity?.runId ?? ""}:${physicalContext?.stageId ?? ""}:${series[0]?.source.resourceKey ?? ""}:${chartId ?? ""}`;
  const [axisChoice, setAxisChoice] = useState<{ datasetKey: string; axis: DispersionAxis } | null>(null);
  const availableAxes = useMemo(() => availableDispersionAxes(series), [series]);
  const automaticAxis = useMemo(() => defaultDispersionAxis(series), [series]);
  const requestedAxis = axisChoice?.datasetKey === datasetKey ? axisChoice.axis : automaticAxis;
  const axis = availableAxes.includes(requestedAxis) ? requestedAxis : automaticAxis;
  const displaySeries = useMemo(() => isDispersion ? projectDispersionSeries(series, axis, selectedPoint) : series, [axis, isDispersion, selectedPoint, series]);
  const chartDisplayUnits = useMemo(() => isDispersion ? { wavevector: "rad/µm", ...displayUnits } : displayUnits, [displayUnits, isDispersion]);
  const displayedSelection = useMemo(() => {
    if (!selectedPoint || !isDispersion) return selectedPoint;
    const entry = displaySeries.find((item) => item.id === selectedPoint.seriesId);
    const point = entry?.points.find((item) => item.rowIndex === selectedPoint.point.rowIndex);
    return point ? { ...selectedPoint, point, xLabel: entry?.xAxisLabel } : null;
  }, [displaySeries, isDispersion, selectedPoint]);
  const titleChart = frequencyTitleChart(tableId, calculationMode);
  const surfaceTitle = titleChart
    ? frequencyDomainResultTitle(titleChart, physicalContext?.classification ?? null)
    : title || descriptor.title;
  const workflow = useMemo(
    () => buildFrequencyDomainWorkflowSummary(tableId, qualifiedCalculationMode),
    [qualifiedCalculationMode, tableId],
  );
  const workbench = useMemo(
    () => buildFrequencyDomainWorkbenchSummary(series, qualifiedCalculationMode, status),
    [qualifiedCalculationMode, series, status],
  );
  const selectedPointSummary = useMemo(
    () => buildFrequencyDomainCursorSummary(displayedSelection, qualifiedCalculationMode, displaySeries),
    [displaySeries, displayedSelection, qualifiedCalculationMode],
  );
  const physicalMetadata = frequencyPhysicalMetadata(
    physicalContext,
    descriptor,
    displayUnits ?? {},
    series,
    presentation,
  );

  if (series.length === 0) {
    if (calculationMode === "fmr_modal_driven") {
      const comparison = comparisonModel ?? {
        diagnostics: [],
        nearestComparison: null,
        pairs: [],
        readiness: "missing-peaks" as const,
      };
      return (
        <ChartSection
          footer={physicalMetadata}
          title={surfaceTitle}
          status={{ presentation, primary: status, trust: "unknown" }}
        >
          <div
            aria-label="Modal-driven comparison"
            className="fm-analysis-plots__empty fm-analysis-plots__comparison"
            role="status"
          >
            <strong>Modal–Driven comparison</strong>
            <span>Readiness: {comparison.readiness}</span>
            {comparison.nearestComparison ? (
              <span>
                Nearest detuning: {comparison.nearestComparison.detuningHz.toExponential(3)} Hz
              </span>
            ) : null}
            {unavailableReason || comparison.diagnostics[0] ? (
              <span>{unavailableReason ?? comparison.diagnostics[0]}</span>
            ) : null}
          </div>
        </ChartSection>
      );
    }
    return (
      <ChartSection
        footer={physicalMetadata}
        title={surfaceTitle}
        status={{
          presentation,
          primary: status,
          trust: "unknown",
        }}
      >
        <div className="fm-analysis-plots__empty" role="status">
          {unavailableReason ?? formatFrequencyDomainEmptyState(status)}
        </div>
      </ChartSection>
    );
  }

  const allIds = series.map((s) => s.id);
  const selected = new Set(sanitizeSelectedSeriesIds(selectedSeriesIds, allIds));

  const yUnits = [...new Set(series.map((entry) => entry.unit))];
  const preferredYUnits = yUnits.map((unit) => {
    const requested = series
      .filter((entry) => entry.unit === unit)
      .map((entry) => displayUnits?.[entry.quantity])
      .filter((value): value is string => Boolean(value));
    return requested.length > 0 && requested.every((value) => value === requested[0])
      ? requested[0]
      : null;
  });
  const yTransforms = createChartYAxisDisplayTransforms(
    yUnits.map((unit) => ({ unit })),
    series.map((entry) => ({
      points: entry.points,
      yAxis: yUnits.indexOf(entry.unit),
    })),
    preferredYUnits,
  );
  const legendItems = series.map((entry, index) => {
    const transform = yTransforms[yUnits.indexOf(entry.unit)] ??
      createChartDisplayTransform(entry.unit, null);
    return {
      id: entry.id,
      label: entry.label || entry.quantity,
      unit: transform.displayUnit,
      latestValue: formatChartDisplayValue(
        entry.points.at(-1)?.y ?? Number.NaN,
        transform,
      ),
      colorName: chartColorNameForIndex(index),
      colorIndex: index,
    };
  });

  const visibleSeries = displaySeries.filter(({ id }) => selected.has(id));

  const legend = (
    <ChartLegend
      ariaLabel="Frequency-domain series"
      items={legendItems}
      onSelectedSeriesIdsChange={onSelectedSeriesIdsChange}
      selectedSeriesIds={selectedSeriesIds}
    />
  );

  // Build subtitle for the header from workbench summary fields
  const workbenchParts = [
    workbench.chartKind,
    workbench.pointCount,
    workbench.frequencyRange,
  ].filter(Boolean);
  const workbenchSubtitle = workbenchParts.join(" · ");

  // Cursor footer keeps the selected scientific point visible outside the canvas.
  const footerContent = selectedPointSummary ? (
    <div
      aria-label="Selected frequency-domain point"
      className="fm-chart-section__footer-row fm-analysis-plots__status--frequency-domain-selection"
    >
      <span className="fm-analysis-plots__range-cursor">
        {selectedPointSummary.title}&ensp;{selectedPointSummary.xLabel}: {selectedPointSummary.xValue}&ensp;
        {selectedPointSummary.yLabel}: {selectedPointSummary.yValue}
        {"linewidthValue" in selectedPointSummary && selectedPointSummary.linewidthValue
          ? `  Linewidth: ${selectedPointSummary.linewidthValue}`
          : null}
        &ensp;{selectedPointSummary.inspectorTarget}
      </span>
      {isDispersion && displayedSelection ? <DispersionModeAction
        kernel={kernel} available={displayedSelection.point.modeFieldAvailable === true}
        target={{ runId: physicalContext?.runId ?? null, stageId: physicalContext?.stageId ?? null,
          sampleIndex: displayedSelection.point.sampleIndex, modeIndex: displayedSelection.point.modeIndex,
          sampleId: displayedSelection.point.sampleId, modeId: displayedSelection.point.itemId }}
        onSelectPoint={() => onPointSelect(displayedSelection)}
        identity={`${datasetKey}:${displayedSelection.seriesId}:${displayedSelection.point.rowIndex}`}
      /> : null}
    </div>
  ) : undefined;

  const workbenchContent = (
    <div
      data-analysis-handoff={descriptor.handoff}
      data-analysis-inspector-route={descriptor.inspectorRouteId}
      aria-label="Frequency-domain workbench"
      className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-workbench"
    >
      <span>{workbench.chartKind}</span>
      <span>{workbench.pointCount}</span>
      <span>{workbench.frequencyRange}</span>
      <span>{workbench.fieldHandoff}</span>
      <span>{workbench.status}</span>
    </div>
  );
  const footer = (
    <>
      {footerContent}
      {workbenchContent}
      {physicalMetadata}
    </>
  );

  // Workflow summary uses qualified physical evidence for any FMR wording.
  const workflowToolbar = workflow ? (
    <div
      aria-label="Frequency-domain workflow"
      className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-workflow"
    >
      <span className="fm-chart-section__point-count">Workflow: {workflow.workflow}</span>
      <span className="fm-chart-section__point-count">Next: {workflow.next}</span>
      <span className="fm-chart-section__point-count">Mode fields: {workflow.artifacts}</span>
      <span className="fm-chart-section__point-count">{workflow.inspector}</span>
    </div>
  ) : null;
  const toolbar = <>
    {workflowToolbar}
    {isDispersion ? <DispersionAxisControls
      axis={axis} axes={availableAxes} unit={chartDisplayUnits?.wavevector ?? "rad/µm"}
      onAxisChange={(next) => setAxisChoice({ datasetKey, axis: next })}
      onUnitChange={(unit) => onDisplayUnitsChange({ wavevector: unit })}
    /> : null}
    <ChartDisplayUnitControls displayUnits={displayUnits ?? {}} onDisplayUnitsChange={onDisplayUnitsChange} series={series} />
  </>;

  return (
    <ChartSection
      className="fm-analysis-plots__subchart--frequency-domain"
      footer={footer}
      legend={legend}
      status={{
        presentation,
        primary: status === "ready" ? "Ready" : status,
        showRevision: false,
        // Trust remains unknown until a dedicated validation resource is published.
        trust: "unknown",
        pointSummary: formatSeriesCount(series.length),
      }}
      subtitle={workbenchSubtitle}
      title={surfaceTitle}
      toolbar={toolbar}
    >
      <div
        className="fm-analysis-plots__chart-frame"
        data-resource-key={series[0]?.source.resourceKey}
      >
        {visibleSeries.length === 0 ? (
          <div className="fm-analysis-plots__empty" role="status">Select at least one signal</div>
        ) : (
          <EChartsSurface
            key={isDispersion ? `${datasetKey}:${axis}` : undefined}
            allSeries={displaySeries}
            bus={kernel.bus}
            chartId={chartId}
            dataStatus={status}
            descriptorId={descriptorId}
            displayUnits={chartDisplayUnits}
            initialRange={isDispersion && axis !== "path" ? null : range}
            onPointSelect={onPointSelect}
            onRangeChange={isDispersion && axis !== "path" ? undefined : onRangeChange}
            series={visibleSeries}
            presentation={presentation}
            xAxisLabel={frequencyDomainXAxisLabel(displaySeries)}
          />
        )}
      </div>
    </ChartSection>
  );
}

function frequencyTitleChart(
  tableId: string,
  calculationMode: string | undefined,
): FrequencyDomainChartRoute["primaryChart"] | null {
  if (tableId === "frequency-domain:eigen-dispersion") return "dispersion";
  if (tableId === "frequency-domain:eigen-spectrum") return "modal-spectrum";
  if (tableId === "frequency-domain:response-sweep") return "response-sweep";
  if (calculationMode === "dispersion_modal") return "dispersion";
  if (calculationMode === "response_map") return "response-map";
  if (calculationMode === "fmr_response" || calculationMode === "frequency_response") {
    return "response-sweep";
  }
  if (calculationMode === "fmr_modal_driven") return "comparison";
  if (calculationMode === "fmr_modal" || calculationMode === "free_modes") {
    return "modal-spectrum";
  }
  return null;
}

function frequencyPhysicalMetadata(
  context: FrequencyDomainResultContext | undefined,
  descriptor: ReturnType<typeof descriptorForFrequencyTable>,
  displayUnits: Readonly<Record<string, string>>,
  series: readonly ChartSeries[],
  presentation?: AnalysisFrequencyPresentationState,
) {
  const first = series[0];
  const sourceIdentity = first?.sourceIdentity ?? UNKNOWN_FREQUENCY_SOURCE_IDENTITY;
  if (!context && !first?.sourceIdentity && !first?.dataRevision) return null;
  const observable = context?.observables.length
    ? context.observables.map((entry) => `${entry.identity} (${entry.kind}, ${entry.unit})`).join(", ")
    : "unavailable";
  const yQuantities = series.length
    ? series.map((entry) => `${entry.quantity} [${entry.unit || "1"}]`).join(", ")
    : "unavailable";
  const display = Object.entries(displayUnits).length
    ? Object.entries(displayUnits).map(([quantity, unit]) => `${quantity} [${unit}]`).join(", ")
    : "automatic SI scaling";
  const presentationRevision = presentation?.kind === "ready" || presentation?.kind === "empty"
    ? presentation.revision
    : presentation && "visibleRevision" in presentation
      ? presentation.visibleRevision
      : null;
  const requestedRevision = presentation?.kind === "refreshing"
    ? presentation.requestedRevision
    : presentation?.kind === "paused"
      ? presentation.latestKnownRevision
      : null;
  const runId = context?.runId ?? sourceIdentity.runId;
  const stageId = context?.stageId ?? sourceIdentity.stageId;
  const summary = [
    "Physical context and provenance",
    context ? frequencyKContextLabel(context) : "Context unavailable",
    context?.boundaryContext ?? null,
    context?.contractGaps.length ? "Validation incomplete" : `Qualification ${sourceIdentity.qualification}`,
  ].filter(Boolean).join(" · ");
  return (
    <details aria-label="Frequency-domain physical context" className="fm-analysis-plots__physical-context">
      <summary>{summary}</summary>
      <div className="fm-analysis-plots__physical-context-grid">
        <span>Run: {runId ?? "unavailable"}</span>
        <span>Stage: {stageId ?? "unavailable"}</span>
        <span>Equilibrium: {context?.equilibriumId ?? "unavailable"}</span>
        <span>Geometry: {context?.geometryId ?? "unavailable"}</span>
        <span>Mesh: {context?.meshId ?? "unavailable"}</span>
        <span>Boundary: {context?.boundaryContext ?? "unavailable"}</span>
        <span>Normalization: {context?.normalization ?? "unavailable"}</span>
        <span>k: {context ? frequencyKContextLabel(context) : "unavailable"}</span>
        <span>Observable: {observable}</span>
        <span>SI axes: {descriptor.xAxis.label} [{descriptor.xAxis.unit}] → {yQuantities}</span>
        <span>Display units: {descriptor.xAxis.label} [{first?.xUnit ?? descriptor.xAxis.unit}]; {display}</span>
        {context?.contractGaps.length
          ? <span>Contract gap: {context.contractGaps.join("; ")}</span>
          : null}
        <span>Artifact: {sourceIdentity.artifactPath ?? "unknown"}</span>
        <span>Schema: {sourceIdentity.schemaVersion ?? "unknown"}</span>
        <span>Digest: {sourceIdentity.contentDigest ?? "unknown"}</span>
        <span>Backend: {sourceIdentity.backend ?? "unknown"}</span>
        <span>Device: {sourceIdentity.device ?? "unknown"}</span>
        <span>Precision: {sourceIdentity.precision ?? "unknown"}</span>
        <span>Qualification: {sourceIdentity.qualification}</span>
        <span>Provenance: {sourceIdentity.provenance ?? "unknown"}</span>
        <span>Data revision: {presentationRevision ?? first?.dataRevision ?? "unavailable"}</span>
        {requestedRevision != null ? <span>Requested revision: {requestedRevision}</span> : null}
      </div>
    </details>
  );
}

function frequencyKContextLabel(context: FrequencyDomainResultContext): string {
  if (context.classification) return context.classification.kContext.label;
  if (context.boundaryContext === "finite_open") return "Finite system · k n/a";
  const sampling = context.kSampling;
  if (!sampling) return "unavailable";
  if (sampling.kind === "single") return `k = [${sampling.vectorRadPerM.join(", ")}] rad/m`;
  if (sampling.kind === "path") return sampling.label ? `k path ${sampling.label}` : "k path";
  return "k grid";
}
