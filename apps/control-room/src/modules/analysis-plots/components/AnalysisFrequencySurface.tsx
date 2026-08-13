import { useMemo } from "react";

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
import {
  frequencyDomainResultTitle,
  type FrequencyDomainChartRoute,
  type FrequencyDomainResultContext,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { AnalysisFrequencyPresentationState } from "../hooks/useAnalysisFrequencyData";

export function AnalysisFrequencySurface({
  chartId,
  calculationMode,
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
    () => buildFrequencyDomainCursorSummary(selectedPoint, qualifiedCalculationMode, series),
    [qualifiedCalculationMode, selectedPoint, series],
  );
  const physicalMetadata = frequencyPhysicalMetadata(
    physicalContext,
    descriptor,
    displayUnits ?? {},
    series,
  );

  if (series.length === 0) {
    return (
      <ChartSection
        title={surfaceTitle}
        status={{ presentation, primary: status, trust: "unknown" }}
      >
        {physicalMetadata}
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

  const visibleSeries = series.filter(({ id }) => selected.has(id));

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
    </div>
  ) : undefined;

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
    <ChartDisplayUnitControls displayUnits={displayUnits ?? {}} onDisplayUnitsChange={onDisplayUnitsChange} series={series} />
  </>;

  return (
    <ChartSection
      className="fm-analysis-plots__subchart--frequency-domain"
      footer={footerContent}
      legend={legend}
      status={{
        presentation,
        primary: status === "ready" ? "Ready" : status,
        revision: series[0]?.dataRevision ?? null,
        // Trust remains unknown until a dedicated validation resource is published.
        trust: "unknown",
        pointSummary: formatSeriesCount(series.length),
      }}
      subtitle={workbenchSubtitle}
      title={surfaceTitle}
      toolbar={toolbar}
    >
      {physicalMetadata}
      {/* Workbench summary row (mirrors old Frequency-domain workbench pill row) */}
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
      <div
        className="fm-analysis-plots__chart-frame"
        data-resource-key={series[0]?.source.resourceKey}
      >
        {visibleSeries.length === 0 ? (
          <div className="fm-analysis-plots__empty" role="status">Select at least one signal</div>
        ) : (
          <EChartsSurface
            allSeries={series}
            bus={kernel.bus}
            chartId={chartId}
            dataStatus={status}
            descriptorId={descriptorId}
            displayUnits={displayUnits}
            initialRange={range}
            onPointSelect={onPointSelect}
            onRangeChange={onRangeChange}
            series={visibleSeries}
            presentation={presentation}
            xAxisLabel={frequencyDomainXAxisLabel(series)}
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
) {
  if (!context) return null;
  const first = series[0];
  const observable = context.observables.length
    ? context.observables.map((entry) => `${entry.identity} (${entry.kind}, ${entry.unit})`).join(", ")
    : "unavailable";
  const yQuantities = series.length
    ? series.map((entry) => `${entry.quantity} [${entry.unit || "1"}]`).join(", ")
    : "unavailable";
  const display = Object.entries(displayUnits).length
    ? Object.entries(displayUnits).map(([quantity, unit]) => `${quantity} [${unit}]`).join(", ")
    : "automatic SI scaling";
  return (
    <div aria-label="Frequency-domain physical context" className="fm-analysis-plots__physical-context">
      <span>Run: {context.runId ?? "unavailable"}</span>
      <span>Stage: {context.stageId ?? "unavailable"}</span>
      <span>Equilibrium: {context.equilibriumId ?? "unavailable"}</span>
      <span>Geometry: {context.geometryId ?? "unavailable"}</span>
      <span>Mesh: {context.meshId ?? "unavailable"}</span>
      <span>Boundary: {context.boundaryContext ?? "unavailable"}</span>
      <span>k: {frequencyKContextLabel(context)}</span>
      <span>Observable: {observable}</span>
      <span>SI axes: {descriptor.xAxis.label} [{descriptor.xAxis.unit}] → {yQuantities}</span>
      <span>Display units: {descriptor.xAxis.label} [{first?.xUnit ?? descriptor.xAxis.unit}]; {display}</span>
      {context.contractGaps.length > 0
        ? <span>Contract gap: {context.contractGaps.join("; ")}</span>
        : null}
    </div>
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
