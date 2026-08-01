import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";

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

function formatFreqLatest(y: number | undefined): string {
  if (y === undefined || !Number.isFinite(y)) return "—";
  return y.toPrecision(4);
}

export function AnalysisFrequencySurface({
  hiddenSeriesIds = [],
  kernel,
  onPointSelect,
  onSolo,
  onToggleVisibility,
  selectedPoint,
  series,
  status,
  title,
  unavailableReason,
}: {
  hiddenSeriesIds?: readonly string[];
  kernel: KernelApi;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onSolo?: (seriesId: string | null, allSeriesIds?: readonly string[]) => void;
  onToggleVisibility?: (seriesId: string) => void;
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
  const selected = useMemo(
    () => buildFrequencyDomainCursorSummary(selectedPoint, title),
    [selectedPoint, title],
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
  const hidden = hiddenSeriesIds.filter((id) => allIds.includes(id));
  const soloedId =
    hidden.length > 0 && hidden.length === allIds.length - 1
      ? allIds.find((id) => !hidden.includes(id)) ?? null
      : null;

  const legendItems = series.map((s, index) => ({
    id: s.id,
    label: s.label || s.quantity,
    unit: s.unit,
    latestValue: formatFreqLatest(s.points.at(-1)?.y),
    colorName: chartColorNameForIndex(index),
    colorIndex: index,
    hidden: hidden.includes(s.id),
    soloed: soloedId !== null && soloedId === s.id,
  }));

  const visibleSeries = hidden.length === 0
    ? series
    : series.filter((s) => !hidden.includes(s.id));

  const legend = (
    <ChartLegend
      ariaLabel="Frequency-domain series"
      items={legendItems}
      onToggleVisibility={onToggleVisibility ?? (() => {})}
      onSolo={(id) => onSolo?.(id, allIds)}
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
  const footerContent = selected ? (
    <div
      aria-label="Selected frequency-domain point"
      className="fm-chart-section__footer-row fm-analysis-plots__status--frequency-domain-selection"
    >
      <span className="fm-analysis-plots__range-cursor">
        {selected.title}&ensp;{selected.xLabel}: {selected.xValue}&ensp;
        {selected.yLabel}: {selected.yValue}
        {"linewidthValue" in selected && selected.linewidthValue
          ? `  Linewidth: ${selected.linewidthValue}`
          : null}
        &ensp;{selected.inspectorTarget}
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
        <EChartsSurface
          allSeries={series}
          bus={kernel.bus}
          dataStatus={status}
          onPointSelect={onPointSelect}
          series={visibleSeries}
          xAxisLabel={frequencyDomainXAxisLabel(series)}
        />
      </div>
    </ChartSection>
  );
}
