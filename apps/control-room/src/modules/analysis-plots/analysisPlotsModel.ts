import {
  buildTableRowsQuery,
  type ChartSeries,
  type ChartValueRange,
  DEFAULT_TABLE_CHART_COLUMNS,
  type TableRowsQuery,
  tableRowsVisibleRangeQuery,
} from "./chartTableModel";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ANALYSIS_SCALAR_COLUMNS } from "./tableRowsAdapter";
import {
  type AxisColumnUnit,
  nextYAxisIdsForToggle,
  sanitizeYAxisIdsForUnitLimit,
} from "@/shared/domain/analysis/TableColumnList";

export function formatAnalysisPointValue(value: number, unit: string): string {
  const formatted =
    Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)
      ? value.toExponential(3)
      : String(Number(value.toPrecision(5)));
  return unit ? `${formatted} ${unit}` : formatted;
}

export function buildAnalysisPlotsTableQuery({
  cursor,
  range,
  xAxisId,
}: {
  cursor: number | undefined;
  range: ChartValueRange | null;
  xAxisId: string;
}): TableRowsQuery {
  return buildTableRowsQuery({
    columns: ANALYSIS_SCALAR_COLUMNS,
    cursor,
    range: range
      ? tableRowsVisibleRangeQuery({
          fromValue: range.fromValue,
          toValue: range.toValue,
          xAxisId,
        })
      : null,
    targetPoints: 1_600,
  });
}

export function shouldFetchAnalysisTableRows({
  hasVisibleRows,
  loadScalars,
  range,
}: {
  hasVisibleRows: boolean;
  loadScalars: boolean;
  range: ChartValueRange | null;
}): boolean {
  if (!loadScalars) return false;
  return !hasVisibleRows || range !== null;
}

export function resolveAnalysisPlotsYAxisIds(
  yAxisIds: readonly string[],
  columns: readonly AxisColumnUnit[] | null | undefined,
  xAxisId: string,
): string[] {
  if (!columns) return yAxisIds.filter((id) => id !== xAxisId);
  const sanitized = sanitizeYAxisIdsForUnitLimit(yAxisIds, columns, xAxisId);
  if (sanitized.length > 0) return sanitized;

  const availableColumnIds = new Set(columns.map((column) => column.column_id));
  const preferredYAxisIds = DEFAULT_TABLE_CHART_COLUMNS.filter(
    (columnId) =>
      columnId !== xAxisId &&
      columnId !== "step" &&
      columnId !== "t" &&
      availableColumnIds.has(columnId),
  );
  const fallbackYAxisIds =
    preferredYAxisIds.length > 0
      ? preferredYAxisIds
      : columns
          .map((column) => column.column_id)
          .filter((columnId) => columnId !== xAxisId);

  return sanitizeYAxisIdsForUnitLimit(fallbackYAxisIds, columns, xAxisId);
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
  return nextYAxisIdsForToggle(yAxisIds, columnId, true, {
    columns,
    xAxisId,
  });
}

export function analysisPlotsRangeSelectedEvent({
  range,
  xAxisId,
}: {
  range: ChartValueRange | null;
  xAxisId: string;
}): Omit<KernelEventMap["charts:range-selected"], "source"> {
  return {
    chartId: "default",
    range,
    tableId: "default",
    xAxisId,
  };
}

export function analysisPlotsSeriesSelectedEvent(
  series: ChartSeries,
): Omit<KernelEventMap["charts:series-selected"], "source"> {
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
