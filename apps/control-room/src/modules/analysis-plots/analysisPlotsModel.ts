import {
  buildTableRowsQuery,
  type ChartSeries,
  type ChartValueRange,
  DEFAULT_TABLE_CHART_COLUMNS,
  isTableTimeAxisId,
  type TableRowsQuery,
  tableRowsVisibleRangeQuery,
} from "./chartTableModel";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import type { ChartRangeModeState as AnalysisChartRangeMode } from "@/shared/analysis-charts/ChartControlBar";
import { ANALYSIS_SCALAR_COLUMNS } from "./tableRowsAdapter";
import { type AxisColumnUnit, sanitizeYAxisIdsForUnitLimit } from "@/shared/domain/analysis/TableColumnList";

export function formatAnalysisPointValue(value: number, unit: string): string {
  const formatted =
    Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)
      ? value.toExponential(3)
      : String(Number(value.toPrecision(5)));
  return unit ? `${formatted} ${unit}` : formatted;
}

export function buildAnalysisPlotsTableQuery({
  columns = ANALYSIS_SCALAR_COLUMNS,
  cursor,
  latestX,
  range,
  rangeMode = { mode: "follow" },
  targetPoints = 1_600,
  xAxisId,
}: {
  columns?: readonly string[];
  cursor: number | undefined;
  latestX?: number | null;
  range: ChartValueRange | null;
  rangeMode?: AnalysisChartRangeMode;
  targetPoints?: number;
  xAxisId: string;
}): TableRowsQuery {
  if (rangeMode.mode === "tailRows") {
    return buildTableRowsQuery({
      columns,
      cursor,
      includeTail: true,
      limit: rangeMode.rows,
      targetPoints: rangeMode.rows,
    });
  }
  if (
    rangeMode.mode === "tailTime" &&
    isTableTimeAxisId(xAxisId) &&
    Number.isFinite(latestX)
  ) {
    return buildTableRowsQuery({
      columns,
      range: {
        fromT: (latestX as number) - rangeMode.durationS,
        toT: latestX as number,
      },
      targetPoints,
    });
  }
  if (rangeMode.mode === "fullDecimated") {
    return buildTableRowsQuery({
      columns,
      includeTail: false,
      limit: targetPoints,
      targetPoints,
    });
  }
  return buildTableRowsQuery({
    columns,
    cursor,
    range: range
      ? tableRowsVisibleRangeQuery({
          fromValue: range.fromValue,
          toValue: range.toValue,
          xAxisId,
        })
      : null,
    targetPoints,
  });
}

/** A `tailTime` preference has no server meaning unless the selected X axis is simulation time. */
export function normalizeTableRangeModeForXAxis(
  rangeMode: AnalysisChartRangeMode,
  xAxisId: string,
): AnalysisChartRangeMode {
  return rangeMode.mode === "tailTime" && !isTableTimeAxisId(xAxisId)
    ? { mode: "follow" }
    : rangeMode;
}

export function resolveAnalysisPlotsYAxisIds(
  yAxisIds: readonly string[],
  columns: readonly AxisColumnUnit[] | null | undefined,
  xAxisId: string,
): string[] {
  if (!columns) return yAxisIds.filter((id) => id !== xAxisId);
  return sanitizeYAxisIdsForUnitLimit(yAxisIds, columns, xAxisId);
}

export function resolveAnalysisPlotsRequestedSeriesYAxisIds({
  columnId,
  columns,
  xAxisId,
  yAxisIds,
}: {
  columnId: string;
  columns: readonly AxisColumnUnit[];
  xAxisId: string;
  yAxisIds: readonly string[];
}): string[] {
  if (columnId === xAxisId) return [...yAxisIds];
  if (!columns.some((column) => column.column_id === columnId)) {
    return [...yAxisIds];
  }
  return sanitizeYAxisIdsForUnitLimit([...yAxisIds, columnId], columns, xAxisId);
}

export function analysisPlotsRangeSelectedEvent({
  range,
  xAxisId,
}: {
  range: ChartValueRange | null;
  xAxisId: string;
}): Omit<KernelEventMap["analysis-plots:range-selected"], "source"> {
  return {
    chartId: "default",
    range,
    tableId: "default",
    xAxisId,
  };
}

export function analysisPlotsSeriesSelectedEvent(
  series: ChartSeries,
): Omit<KernelEventMap["analysis-plots:series-selected"], "source"> {
  return {
    chartId: series.source.tableId,
    quantity: series.quantity,
    resourceKey: series.source.resourceKey,
    seriesId: series.id,
    tableId: series.source.tableId,
  };
}

export function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
