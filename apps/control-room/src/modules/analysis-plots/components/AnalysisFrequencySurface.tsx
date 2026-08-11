import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
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
  displayUnits,
  descriptorId,
  kernel,
  onPointSelect,
  onRangeChange = () => undefined,
  onDisplayUnitsChange = () => undefined,
  onSelectedSeriesIdsChange,
  selectedSeriesIds,
  selectedPoint,
  series,
  range = null,
  status,
  title,
  unavailableReason,
}: {
  chartId?: string;
  displayUnits?: Readonly<Record<string, string>>;
  descriptorId?: string;
  kernel: KernelApi;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  onDisplayUnitsChange?: (patch: Record<string, string>) => void;
  onSelectedSeriesIdsChange: (selectedSeriesIds: string[]) => void;
  selectedSeriesIds: readonly string[];
  selectedPoint: AnalysisChartCursorPoint | null;
  series: readonly ChartSeries[];
  range?: ChartValueRange | null;
  status: string;
  title: string;
  unavailableReason: string | null;
}) {
  const workflow = useMemo(() => buildFrequencyDomainWorkflowSummary(title), [title]);
  const workbench = useMemo(
    () => buildFrequencyDomainWorkbenchSummary(series, title, status),
    [series, status, title],
  );
  const selectedPointSummary = useMemo(
    () => buildFrequencyDomainCursorSummary(selectedPoint, title, series),
    [selectedPoint, series, title],
  );

  if (series.length === 0) {
    return (
      <ChartSection
        title={title}
        status={{
          primary: status,
          sourceIdentity: UNKNOWN_FREQUENCY_SOURCE_IDENTITY,
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

  // Workflow summary (visible for FMR modal / FMR driven titles only)
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
        primary: status === "ready" ? "Ready" : status,
        revision: series[0]?.dataRevision ?? null,
        // The current frequency-domain resources do not carry qualification.
        trust: "unknown",
        pointSummary: formatSeriesCount(series.length),
        sourceIdentity:
          series[0]?.sourceIdentity ?? UNKNOWN_FREQUENCY_SOURCE_IDENTITY,
      }}
      subtitle={workbenchSubtitle}
      title={title}
      toolbar={toolbar}
    >
      {/* Workbench summary row (mirrors old Frequency-domain workbench pill row) */}
      <div
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
            xAxisLabel={frequencyDomainXAxisLabel(series)}
          />
        )}
      </div>
    </ChartSection>
  );
}
