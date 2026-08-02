import type {
  AnalysisChartCursorPoint,
} from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartPoint, ChartSeries } from "@/shared/domain/analysis/chartSeries";
import {
  buildScalarChartSeries,
  type TableRowsLike,
} from "@/shared/domain/analysis/scalarTableChart";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";

export const DEFAULT_TABLE_CHART_COLUMNS = Object.freeze([
  "step",
  "t",
  "mx",
  "my",
  "mz",
  "e_total",
  "max_torque_Apm",
] as const);

type TableDecimationMode = "minmax_lttb";

export interface TableRowsQuery {
  columns: readonly string[];
  cursor?: number;
  decimation: TableDecimationMode;
  fromRow?: number;
  fromT?: number;
  includeTail: boolean;
  limit: number;
  targetPoints: number;
  toRow?: number;
  toT?: number;
}

export interface TableRowsRangeQuery {
  fromRow?: number;
  fromT?: number;
  toRow?: number;
  toT?: number;
}

export interface ChartValueRange {
  fromValue: number;
  toValue: number;
}

/** The table rows API can slice by simulation time only, never by an arbitrary quantity. */
export function isTableTimeAxisId(columnId: string): boolean {
  return columnId === "t" || columnId === "time";
}

export type { ChartPoint, ChartSeries } from "@/shared/domain/analysis/chartSeries";
export {
  buildScalarChartSeries,
  buildScalarTableSeries,
  type ScalarTableChartInput,
  type TableRowsLike,
} from "@/shared/domain/analysis/scalarTableChart";

export interface AxisUnitGroup {
  axisIndex: number;
  columnIds: string[];
  unit: string;
}

export interface EChartsDatasetModel {
  dataset: {
    source: (number | string)[][];
  };
  series: {
    encode: {
      x: string;
      y: string;
    };
    name: string;
    type: "line";
    yAxisIndex: number;
  }[];
  xAxisId: string;
  yAxis: { name: string }[];
}

export type ChartCursorPoint = AnalysisChartCursorPoint;

const DEFAULT_TABLE_ROW_LIMIT = 5_000;
const MIN_TARGET_POINTS = 160;
const MAX_TARGET_POINTS = 5_000;
const DEFAULT_X_AXIS_COLUMN_ID = "step";

export function buildTableRowsQuery({
  columns = DEFAULT_TABLE_CHART_COLUMNS,
  cursor,
  fromRow,
  fromT,
  includeTail,
  limit,
  range,
  targetPoints,
  toRow,
  toT,
}: {
  columns?: readonly string[];
  cursor?: number;
  fromRow?: number;
  fromT?: number;
  includeTail?: boolean;
  limit?: number;
  range?: TableRowsRangeQuery | null;
  targetPoints?: number;
  toRow?: number;
  toT?: number;
} = {}): TableRowsQuery {
  const visibleRange = range ?? { fromRow, fromT, toRow, toT };
  const hasVisibleRange =
    visibleRange.fromRow !== undefined ||
    visibleRange.fromT !== undefined ||
    visibleRange.toRow !== undefined ||
    visibleRange.toT !== undefined;
  return {
    columns,
    cursor: hasVisibleRange ? undefined : cursor,
    decimation: "minmax_lttb",
    fromRow: visibleRange.fromRow,
    fromT: visibleRange.fromT,
    includeTail: includeTail ?? !hasVisibleRange,
    limit: clampInteger(limit ?? DEFAULT_TABLE_ROW_LIMIT, 10, DEFAULT_TABLE_ROW_LIMIT),
    targetPoints: clampInteger(
      targetPoints ?? 1_600,
      MIN_TARGET_POINTS,
      MAX_TARGET_POINTS,
    ),
    toRow: visibleRange.toRow,
    toT: visibleRange.toT,
  };
}

export function tableRowsVisibleRangeQuery({
  fromValue,
  toValue,
  xAxisId,
}: {
  fromValue: number;
  toValue: number;
  xAxisId: string;
}): TableRowsRangeQuery | null {
  if (!Number.isFinite(fromValue) || !Number.isFinite(toValue)) return null;
  const from = Math.min(fromValue, toValue);
  const to = Math.max(fromValue, toValue);
  if (isTableTimeAxisId(xAxisId)) {
    return { fromT: from, toT: to };
  }
  if (xAxisId !== "step") return null;
  return {
    fromRow: Math.max(0, Math.floor(from)),
    toRow: Math.max(0, Math.ceil(to)),
  };
}

export function chartRangeFromDataZoomEvent(event: unknown): ChartValueRange | null {
  const record = event && typeof event === "object" ? event : null;
  if (!record) return null;
  const batch = "batch" in record ? record.batch : null;
  const entry =
    Array.isArray(batch) && batch.length > 0
      ? batch[0]
      : record;
  if (!entry || typeof entry !== "object") return null;
  const startValue = "startValue" in entry ? Number(entry.startValue) : NaN;
  const endValue = "endValue" in entry ? Number(entry.endValue) : NaN;
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  return {
    fromValue: Math.min(startValue, endValue),
    toValue: Math.max(startValue, endValue),
  };
}

export function groupSeriesByAxisUnit(
  series: readonly { columnId: string; unit: string }[],
): AxisUnitGroup[] {
  const groups: AxisUnitGroup[] = [];
  const groupsByUnit = new Map<string, AxisUnitGroup>();
  for (const item of series) {
    let group = groupsByUnit.get(item.unit);
    if (!group) {
      if (groups.length >= 2) continue;
      group = {
        axisIndex: groups.length,
        columnIds: [],
        unit: item.unit,
      };
      groups.push(group);
      groupsByUnit.set(item.unit, group);
    }
    group.columnIds.push(item.columnId);
  }
  return groups;
}

export function buildChartSeriesModel(
  table: TableRowsLike,
  {
    xAxisId = DEFAULT_X_AXIS_COLUMN_ID,
    yAxisIds,
  }: {
    xAxisId?: string;
    yAxisIds?: readonly string[];
  } = {},
): EChartsDatasetModel {
  const columnIds = table.columns.map((column) => column.column_id);
  const resolvedXAxisId = resolveXAxisId(columnIds, xAxisId);
  const yAxisIdSet = new Set(
    yAxisIds ?? columnIds.filter((columnId) => columnId !== resolvedXAxisId),
  );
  yAxisIdSet.delete(resolvedXAxisId);
  const yColumns = table.columns.filter((column) =>
    yAxisIdSet.has(column.column_id),
  );
  const axisGroups = groupSeriesByAxisUnit(
    yColumns.map((column) => ({
      columnId: column.column_id,
      unit: column.unit,
    })),
  );
  const axisIndexByColumn = new Map(
    axisGroups.flatMap((group) =>
      group.columnIds.map((columnId) => [columnId, group.axisIndex] as const),
    ),
  );

  return {
    dataset: {
      source: [columnIds, ...materializeTableRows(table)],
    },
    series: yColumns.flatMap((column) => {
      const yAxisIndex = axisIndexByColumn.get(column.column_id);
      if (yAxisIndex === undefined) return [];
      return [
        {
          encode: { x: resolvedXAxisId, y: column.column_id },
          name: column.unit
            ? `${column.label || column.column_id} [${column.unit}]`
            : (column.label || column.column_id),
          type: "line",
          yAxisIndex,
        },
      ];
    }),
    xAxisId: resolvedXAxisId,
    yAxis: axisGroups.map((group) => ({ name: group.unit })),
  };
}


function materializeTableRows(table: TableRowsLike): number[][] {
  const rows: number[][] = [];
  const count = tableRowCount(table);
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    rows.push(
      table.columns.map(
        (_column, columnIndex) =>
          tableValueAt(table, rowIndex, columnIndex) ?? Number.NaN,
      ),
    );
  }
  return rows;
}

function tableRowCount(table: TableRowsLike): number {
  return table.rows?.length ?? table.rowCount ?? 0;
}

function tableValueAt(
  table: TableRowsLike,
  rowIndex: number,
  columnIndex: number,
): number | undefined {
  return table.valueAt
    ? table.valueAt(rowIndex, columnIndex)
    : table.rows?.[rowIndex]?.[columnIndex];
}

function chartCursorPointFromSeriesPoint(
  series: ChartSeries,
  point: ChartPoint,
): ChartCursorPoint {
  return {
    label: series.label || series.quantity,
    point,
    quantity: series.quantity,
    seriesId: series.id,
    source: series.source,
    unit: series.unit,
    xUnit: series.xUnit,
  };
}

export function chartCursorPointFromEChartsClick(
  event: unknown,
  chartSeries: readonly ChartSeries[],
): ChartCursorPoint | null {
  const record = event && typeof event === "object" ? event : null;
  if (!record) return null;
  const seriesIndex =
    "seriesIndex" in record ? Number(record.seriesIndex) : NaN;
  const dataIndex = "dataIndex" in record ? Number(record.dataIndex) : NaN;
  if (
    !Number.isInteger(seriesIndex) ||
    !Number.isInteger(dataIndex) ||
    seriesIndex < 0 ||
    dataIndex < 0
  ) {
    return null;
  }
  const series = chartSeries[seriesIndex];
  const point = series?.points[dataIndex];
  return series && point ? chartCursorPointFromSeriesPoint(series, point) : null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function resolveXAxisId(columnIds: readonly string[], xAxisId: string): string {
  return columnIds.includes(xAxisId)
    ? xAxisId
    : columnIds.includes(DEFAULT_X_AXIS_COLUMN_ID)
      ? DEFAULT_X_AXIS_COLUMN_ID
      : (columnIds[0] ?? DEFAULT_X_AXIS_COLUMN_ID);
}

export { yAxisIdsAfterXAxisSelection };
