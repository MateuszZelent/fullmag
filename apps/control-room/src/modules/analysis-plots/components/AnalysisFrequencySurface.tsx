import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { sanitizeSelectedSeriesIds } from "@/shared/analysis-charts/chartSeriesSelection";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import {
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
  formatChartDisplayValue,
} from "@/shared/analysis-charts/chartScalePolicy";

import type { ChartSeries } from "../chartTableModel";
import {
  buildFrequencyDomainCursorSummary,
  buildFrequencyDomainWorkbenchSummary,
  buildFrequencyDomainWorkflowSummary,
  formatFrequencyDomainEmptyState,
  formatSeriesCount,
} from "../analysisWorkbenchModel";
import { frequencyDomainXAxisLabel } from "../frequencyDomainSeriesAdapter";
import { EChartsSurface } from "./EChartsSurface";

export function AnalysisFrequencySurface({
  kernel,
  onPointSelect,
  onSelectedSeriesIdsChange,
  selectedSeriesIds,
  selectedPoint,
  series,
  status,
  title,
  unavailableReason,
}: {
  kernel: KernelApi;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onSelectedSeriesIdsChange?: (selectedSeriesIds: string[]) => void;
  selectedSeriesIds?: readonly string[];
  selectedPoint: AnalysisChartCursorPoint | null;
  series: readonly ChartSeries[];
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
        status={{ primary: status, trust: "unknown" }}
      >
        <div className="fm-analysis-plots__empty" role="status">
          {unavailableReason ?? formatFrequencyDomainEmptyState(status)}
        </div>
      </ChartSection>
    );
  }

  const allIds = series.map((s) => s.id);
  const effectiveSelectedSeriesIds = selectedSeriesIds ?? allIds;
  const selected = new Set(sanitizeSelectedSeriesIds(effectiveSelectedSeriesIds, allIds));

  const yUnits = [...new Set(series.map((entry) => entry.unit))];
  const yTransforms = createChartYAxisDisplayTransforms(
    yUnits.map((unit) => ({ unit })),
    series.map((entry) => ({
      points: entry.points,
      yAxis: yUnits.indexOf(entry.unit),
    })),
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
      selectedSeriesIds={effectiveSelectedSeriesIds}
    />
  );

  // Build subtitle for the header from workbench summary fields
  const workbenchParts = [
    workbench.chartKind,
    workbench.pointCount,
    workbench.frequencyRange,
  ].filter(Boolean);
  const workbenchSubtitle = workbenchParts.join(" · ");

  // Cursor footer spans (mirrors AnalysisStatusPill content for backward compat)
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
  const toolbar = workflow ? (
    <div
      aria-label="Frequency-domain workflow"
      className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-workflow"
    >
      <span className="fm-chart-section__point-count">Workflow: {workflow.workflow}</span>
      <span className="fm-chart-section__point-count">Next: {workflow.next}</span>
      <span className="fm-chart-section__point-count">Mode fields: {workflow.artifacts}</span>
      <span className="fm-chart-section__point-count">{workflow.inspector}</span>
    </div>
  ) : undefined;

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
            dataStatus={status}
            onPointSelect={onPointSelect}
            series={visibleSeries}
            xAxisLabel={frequencyDomainXAxisLabel(series)}
          />
        )}
      </div>
    </ChartSection>
  );
}
