export const DEFAULT_TABLE_CHART_COLUMNS = Object.freeze([
  "step",
  "t",
  "mx",
  "my",
  "mz",
  "e_total",
  "max_torque",
] as const);

export type TableDecimationMode = "minmax_lttb";

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

export interface TableColumnMeta {
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

const DEFAULT_TABLE_ROW_LIMIT = 5_000;
const MIN_TARGET_POINTS = 160;
const MAX_TARGET_POINTS = 5_000;
export const DEFAULT_X_AXIS_COLUMN_ID = "step";

export function buildTableRowsQuery({
  columns = DEFAULT_TABLE_CHART_COLUMNS,
  cursor,
  fromRow,
  fromT,
  targetPoints,
  toRow,
  toT,
}: {
  columns?: readonly string[];
  cursor?: number;
  fromRow?: number;
  fromT?: number;
  targetPoints?: number;
  toRow?: number;
  toT?: number;
} = {}): TableRowsQuery {
  return {
    columns,
    cursor,
    decimation: "minmax_lttb",
    fromRow,
    fromT,
    includeTail: true,
    limit: DEFAULT_TABLE_ROW_LIMIT,
    targetPoints: clampInteger(
      targetPoints ?? 1_600,
      MIN_TARGET_POINTS,
      MAX_TARGET_POINTS,
    ),
    toRow,
    toT,
  };
}

export function yAxisIdsAfterXAxisSelection(
  yAxisIds: readonly string[],
  xAxisId: string,
): string[] {
  return yAxisIds.filter((id) => id !== xAxisId);
}

export function groupSeriesByAxisUnit(
  series: readonly { columnId: string; unit: string }[],
): AxisUnitGroup[] {
  const groups: AxisUnitGroup[] = [];
  for (const item of series) {
    let group = groups.find((candidate) => candidate.unit === item.unit);
    if (!group) {
      if (groups.length >= 2) continue;
      group = {
        axisIndex: groups.length,
        columnIds: [],
        unit: item.unit,
      };
      groups.push(group);
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
  const resolvedXAxisId = columnIds.includes(xAxisId)
    ? xAxisId
    : columnIds.includes(DEFAULT_X_AXIS_COLUMN_ID)
      ? DEFAULT_X_AXIS_COLUMN_ID
      : (columnIds[0] ?? DEFAULT_X_AXIS_COLUMN_ID);
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
    series: yColumns
      .filter((column) => axisIndexByColumn.has(column.column_id))
      .map((column) => ({
        encode: { x: resolvedXAxisId, y: column.column_id },
        name: column.unit
          ? `${column.label || column.column_id} [${column.unit}]`
          : (column.label || column.column_id),
        type: "line",
        yAxisIndex: axisIndexByColumn.get(column.column_id) ?? 0,
      })),
    xAxisId: resolvedXAxisId,
    yAxis: axisGroups.map((group) => ({ name: group.unit })),
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
