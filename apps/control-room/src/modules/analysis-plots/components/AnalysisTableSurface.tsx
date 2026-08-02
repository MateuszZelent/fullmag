"use client";

import type { KernelApi } from "@/kernel/types";
import type { ChartLiveMode } from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import {
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
  formatChartDisplayValue,
} from "@/shared/analysis-charts/chartScalePolicy";

import { type ChartSeries, type ChartValueRange } from "../chartTableModel";
import {
  formatRange,
  tableWindowRowCount,
  tableWindowTotalRows,
} from "../analysisWorkbenchModel";
import { EChartsSurface } from "./EChartsSurface";

function statusPrimary(status: string, liveMode: ChartLiveMode): string {
  if (status === "error") return "Error";
  if (status === "unsupported") return "Unavailable";
  if (status === "empty" || status === "idle") return "No table data";
  if (status === "degraded") return "Degraded";
  if (status === "loading" || status === "stale") {
    return liveMode === "paused" ? "Paused" : "Loading…";
  }
  return liveMode === "paused" ? "Paused" : "Live";
}

/**
 * Center surface for an Analysis chart.
 *
 * Configuration intentionally belongs to ChartInspectorPanel. Keeping this
 * component display-only avoids a second, divergent set of controls beside
 * the dedicated inspector.
 */
export function AnalysisTableSurface({
  chartSeries,
  hiddenSeriesIds = [],
  kernel,
  liveMode = "following",
  onPointSelect,
  onRangeChange,
  onToggleVisibility,
  range,
  selectedPoint,
  status,
  table,
  xAxisId,
  xAxisLabel,
}: {
  chartSeries: readonly ChartSeries[];
  hiddenSeriesIds?: readonly string[];
  kernel: KernelApi;
  liveMode?: ChartLiveMode;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange: (range: ChartValueRange) => void;
  onToggleVisibility?: (seriesId: string) => void;
  range: ChartValueRange | null;
  selectedPoint: AnalysisChartCursorPoint | null;
  status: string;
  table: ChartTableWindow | null;
  xAxisId: string;
  xAxisLabel: string;
}) {
  const fitRequest = useAnalysisPlotsWorkspaceSelector((state) => state.fitRequest);
  const allIds = chartSeries.map((series) => series.id);
  const hidden = hiddenSeriesIds.filter((id) => allIds.includes(id));
  const visibleSeries = hidden.length === 0
    ? chartSeries
    : chartSeries.filter((series) => !hidden.includes(series.id));
  const yUnits = [...new Set(chartSeries.map((series) => series.unit))];
  const yTransforms = createChartYAxisDisplayTransforms(
    yUnits.map((unit) => ({ unit })),
    chartSeries.map((series) => ({
      points: series.points,
      yAxis: yUnits.indexOf(series.unit),
    })),
  );
  const displayTransforms = new Map(chartSeries.map((series) => [
    series.id,
    yTransforms[yUnits.indexOf(series.unit)] ??
      createChartDisplayTransform(series.unit, null),
  ]));
  const legendItems = chartSeries.map((series, index) => {
    const transform = displayTransforms.get(series.id)!;
    return {
      colorIndex: index,
      colorName: chartColorNameForIndex(index),
      hidden: hidden.includes(series.id),
      id: series.id,
      label: series.label || series.quantity,
      latestValue: formatChartDisplayValue(
        series.points.at(-1)?.y ?? Number.NaN,
        transform,
      ),
      soloed: false,
      unit: transform.displayUnit,
    };
  });
  const rowCount = tableWindowRowCount(table);
  const totalRows = table ? tableWindowTotalRows(table) : 0;
  const selectedTransform = selectedPoint
    ? displayTransforms.get(selectedPoint.seriesId) ??
      createChartDisplayTransform(selectedPoint.unit, null)
    : null;
  const cursorText = selectedPoint && selectedTransform
    ? `cursor ${selectedPoint.label}: ${selectedTransform.formatValue(selectedPoint.point.y)}`
    : "cursor —";

  return (
    <ChartSection
      footer={
        <div className="fm-chart-section__footer-row">
          <span className="fm-analysis-plots__range-cursor">{cursorText}</span>
          {range ? (
            <span className="fm-analysis-plots__range-zoom">
              zoom {formatRange(range)}
            </span>
          ) : null}
        </div>
      }
      legend={
        legendItems.length > 0 ? (
          <ChartLegend
            ariaLabel="Chart series"
            items={legendItems}
            onToggleVisibility={onToggleVisibility}
          />
        ) : null
      }
      status={{
        isAlert: status === "error",
        pointSummary: rowCount > 0
          ? `${rowCount.toLocaleString()}${totalRows > rowCount ? ` / ${totalRows.toLocaleString()}` : ""} rows`
          : undefined,
        primary: statusPrimary(status, liveMode),
        revision: table?.revision ?? null,
        trust: "unknown",
      }}
      title={xAxisId}
    >
      <EChartsSurface
        allSeries={chartSeries}
        bus={kernel.bus}
        dataStatus={status}
        fitRequest={fitRequest}
        onPointSelect={onPointSelect}
        onRangeChange={onRangeChange}
        series={visibleSeries}
        xAxisLabel={xAxisLabel}
      />
    </ChartSection>
  );
}
