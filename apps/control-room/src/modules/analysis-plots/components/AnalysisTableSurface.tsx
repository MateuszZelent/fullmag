"use client";

import type { KernelApi } from "@/kernel/types";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { sanitizeSelectedSeriesIds } from "@/shared/analysis-charts/chartSeriesSelection";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { ChartDisplayUnitControls } from "@/shared/analysis-charts/ChartDisplayUnitControls";
import { deriveChartPresentationState } from "@/shared/analysis-charts/chartPresentationState";
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

/**
 * Center surface for an Analysis chart.
 *
 * Configuration intentionally belongs to ChartInspectorPanel. Keeping this
 * component display-only avoids a second, divergent set of controls beside
 * the dedicated inspector.
 */
export function AnalysisTableSurface({
  chartSeries,
  chartId,
  displayUnits,
  descriptorId,
  kernel,
  onPointSelect,
  onRangeChange,
  onDisplayUnitsChange = () => undefined,
  onSelectedSeriesIdsChange,
  range,
  selectedSeriesIds,
  selectedPoint,
  status,
  tableRowsRefresh,
  table,
  unsupportedReason,
  xAxisId,
  xAxisLabel,
}: {
  chartSeries: readonly ChartSeries[];
  chartId?: string;
  displayUnits?: Readonly<Record<string, string>>;
  descriptorId?: string;
  kernel: KernelApi;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange: (range: ChartValueRange) => void;
  onDisplayUnitsChange?: (patch: Record<string, string>) => void;
  onSelectedSeriesIdsChange: (selectedSeriesIds: string[]) => void;
  range: ChartValueRange | null;
  selectedSeriesIds: readonly string[];
  selectedPoint: AnalysisChartCursorPoint | null;
  status: string;
  tableRowsRefresh?: Pick<ResourceResult<unknown>, "error" | "revision" | "status">;
  table: ChartTableWindow | null;
  /** Reason supplied by the owning projection when this surface is unsupported. */
  unsupportedReason?: string | null;
  xAxisId: string;
  xAxisLabel: string;
}) {
  const allIds = chartSeries.map((series) => series.id);
  const selected = new Set(sanitizeSelectedSeriesIds(selectedSeriesIds, allIds));
  const visibleSeries = chartSeries.filter(({ id }) => selected.has(id));
  const yUnits = [...new Set(chartSeries.map((series) => series.unit))];
  const preferredYUnits = yUnits.map((unit) => {
    const requested = chartSeries
      .filter((series) => series.unit === unit)
      .map((series) => displayUnits?.[series.quantity])
      .filter((value): value is string => Boolean(value));
    return requested.length > 0 && requested.every((value) => value === requested[0])
      ? requested[0]
      : null;
  });
  const yTransforms = createChartYAxisDisplayTransforms(
    yUnits.map((unit) => ({ unit })),
    chartSeries.map((series) => ({
      points: series.points,
      yAxis: yUnits.indexOf(series.unit),
    })),
    preferredYUnits,
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
      id: series.id,
      label: series.label || series.quantity,
      latestValue: formatChartDisplayValue(
        series.points.at(-1)?.y ?? Number.NaN,
        transform,
      ),
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
  const presentation = deriveChartPresentationState({
    content: table && tableWindowRowCount(table) === 0 ? "empty" : undefined,
    data: table,
    error: tableRowsRefresh?.error ?? (status === "error" ? new Error("Table samples unavailable") : null),
    requestedRevision: tableRowsRefresh?.revision ?? table?.revision ?? null,
    status: status === "unsupported"
      ? "unsupported"
      : tableRowsRefresh?.status ?? resourceStatus(status),
    unsupportedReason: status === "unsupported"
      ? unsupportedReason ?? "Table samples are unsupported by the current runtime."
      : null,
    visibleRevision: table?.revision ?? null,
  }, {
    latestKnownRevision: tableRowsRefresh?.revision ?? null,
    paused: false,
  });

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
            onSelectedSeriesIdsChange={onSelectedSeriesIdsChange}
            selectedSeriesIds={selectedSeriesIds}
          />
        ) : null
      }
      status={{
        pointSummary: rowCount > 0
          ? `${rowCount.toLocaleString()}${totalRows > rowCount ? ` / ${totalRows.toLocaleString()}` : ""} rows`
          : undefined,
        presentation,
        primary: "Ready",
        trust: "unknown",
      }}
      title={xAxisId}
      toolbar={<ChartDisplayUnitControls displayUnits={displayUnits ?? {}} onDisplayUnitsChange={onDisplayUnitsChange} series={chartSeries} />}
    >
      {chartSeries.length > 0 && visibleSeries.length === 0 ? (
        <div className="fm-analysis-plots__empty" role="status">Select at least one signal</div>
      ) : (
        <EChartsSurface
          allSeries={chartSeries}
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
          xAxisLabel={xAxisLabel}
        />
      )}
    </ChartSection>
  );
}

function resourceStatus(status: string): "idle" | "loading" | "ready" | "stale" | "error" | "unsupported" {
  return status === "loading" || status === "ready" || status === "stale" || status === "error" || status === "unsupported"
    ? status
    : "idle";
}
