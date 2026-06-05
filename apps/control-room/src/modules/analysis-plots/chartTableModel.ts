import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type {
  AnalysisChartCursorPoint,
  AnalysisChartResourceRef,
} from "@/shared/domain/analysis/chartCursorPoint";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";

export const DEFAULT_TABLE_CHART_COLUMNS = Object.freeze([
  "step",
  "t",
  "mx",
  "my",
  "mz",
  "e_total",
  "max_torque",
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

interface TableColumnMeta {
  column_id: string;
  dimension: string;
  label: string;
  unit: string;
}

export interface TableRowsLike {
  columns: readonly TableColumnMeta[];
  rows: readonly (readonly number[])[];
}

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

interface ChartPoint {
  rowIndex: number;
  x: number;
  y: number;
}

type ChartResourceRef = AnalysisChartResourceRef;

export interface ChartSeries {
  id: string;
  label: string;
  points: readonly ChartPoint[];
  quantity: string;
  source: ChartResourceRef;
  status: ResourceStatus;
  unit: string;
  xUnit: string;
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
  range,
  targetPoints,
  toRow,
  toT,
}: {
  columns?: readonly string[];
  cursor?: number;
  fromRow?: number;
  fromT?: number;
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
    includeTail: !hasVisibleRange,
    limit: DEFAULT_TABLE_ROW_LIMIT,
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
  if (xAxisId === "t" || xAxisId === "time") {
    return { fromT: from, toT: to };
  }
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
      source: [columnIds, ...table.rows.map((row) => [...row])],
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

export function buildScalarChartSeries(
  table: TableRowsLike,
  {
    status = "ready",
    tableId = "default",
    xAxisId = DEFAULT_X_AXIS_COLUMN_ID,
    yAxisIds,
  }: {
    status?: ResourceStatus;
    tableId?: string;
    xAxisId?: string;
    yAxisIds?: readonly string[];
  } = {},
): ChartSeries[] {
  const columnIds = table.columns.map((column) => column.column_id);
  const resolvedXAxisId = resolveXAxisId(columnIds, xAxisId);
  const xColumnIndex = columnIds.indexOf(resolvedXAxisId);
  const xColumn = table.columns[xColumnIndex];
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
  const allowedColumnIds = new Set(
    axisGroups.flatMap((group) => group.columnIds),
  );
  const source: ChartResourceRef = {
    kind: "data.table.rows",
    resourceKey: tableRowsSourceKey(tableId),
    tableId,
  };

  return yColumns.flatMap((column) => {
    if (!allowedColumnIds.has(column.column_id)) return [];
    const yColumnIndex = columnIds.indexOf(column.column_id);
    return [
      {
        id: `data.table:${tableId}:${resolvedXAxisId}:${column.column_id}`,
        label: column.label || column.column_id,
        points: table.rows.flatMap((row, rowIndex) => {
          const x = Number(row[xColumnIndex]);
          const y = Number(row[yColumnIndex]);
          return Number.isFinite(x) && Number.isFinite(y)
            ? [{ rowIndex, x, y }]
            : [];
        }),
        quantity: column.column_id,
        source,
        status,
        unit: column.unit,
        xUnit: xColumn?.unit ?? "",
      },
    ];
  });
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

function tableRowsSourceKey(tableId: string): string {
  return `/v2/sessions/current/data/tables/${encodeURIComponent(tableId)}/rows`;
}

export { yAxisIdsAfterXAxisSelection };
