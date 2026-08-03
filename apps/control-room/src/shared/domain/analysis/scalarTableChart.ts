import { DATA_TABLE_ROWS_PATH } from "@/kernel/api/apiPaths";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import { tableChartSeriesId } from "@/shared/analysis-charts/chartSeriesSelection";

import type { AnalysisChartResourceRef } from "./chartCursorPoint";
import type { ChartPoint, ChartSeries } from "./chartSeries";

interface TableColumnMeta {
  column_id: string;
  dimension?: string;
  label: string;
  unit: string;
}

export interface TableRowsLike {
  columns: readonly TableColumnMeta[];
  rowCount?: number;
  rows?: readonly (readonly number[])[];
  valueAt?: (rowIndex: number, columnIndex: number) => number | undefined;
}

export interface ScalarTableChartInput {
  dataRevision?: string | number | null;
  status?: ResourceStatus;
  table: TableRowsLike;
  tableId?: string;
  xAxisId?: string;
  yAxisIds?: readonly string[];
}

const DEFAULT_X_AXIS_COLUMN_ID = "step";

export function buildScalarTableSeries({
  dataRevision = null,
  status = "ready",
  table,
  tableId = "default",
  xAxisId = DEFAULT_X_AXIS_COLUMN_ID,
  yAxisIds,
}: ScalarTableChartInput): ChartSeries[] {
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
  const allowedColumnIds = new Set(
    groupSeriesByUnit(yColumns).flatMap((group) => group.columnIds),
  );
  const source: AnalysisChartResourceRef = {
    kind: "data.table.rows",
    resourceKey: tableRowsSourceKey(tableId),
    tableId,
  };

  return yColumns.flatMap((column) => {
    if (!allowedColumnIds.has(column.column_id)) return [];
    const yColumnIndex = columnIds.indexOf(column.column_id);
    return [{
      ...(dataRevision == null ? {} : { dataRevision }),
      id: tableChartSeriesId(tableId, resolvedXAxisId, column.column_id),
      label: column.label || column.column_id,
      points: chartPointsForColumns(table, xColumnIndex, yColumnIndex),
      quantity: column.column_id,
      source,
      status,
      unit: column.unit,
      xUnit: xColumn?.unit ?? "",
    }];
  });
}

export function buildScalarChartSeries(
  table: TableRowsLike,
  input: Omit<ScalarTableChartInput, "table"> = {},
): ChartSeries[] {
  return buildScalarTableSeries({ ...input, table });
}

function groupSeriesByUnit(columns: readonly TableColumnMeta[]): { columnIds: string[]; unit: string }[] {
  const groups: { columnIds: string[]; unit: string }[] = [];
  const groupsByUnit = new Map<string, { columnIds: string[]; unit: string }>();
  for (const column of columns) {
    let group = groupsByUnit.get(column.unit);
    if (!group) {
      if (groups.length >= 2) continue;
      group = { columnIds: [], unit: column.unit };
      groups.push(group);
      groupsByUnit.set(column.unit, group);
    }
    group.columnIds.push(column.column_id);
  }
  return groups;
}

function chartPointsForColumns(
  table: TableRowsLike,
  xColumnIndex: number,
  yColumnIndex: number,
): ChartPoint[] {
  const points: ChartPoint[] = [];
  const count = table.rows?.length ?? table.rowCount ?? 0;
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    const x = Number(tableValueAt(table, rowIndex, xColumnIndex));
    const y = Number(tableValueAt(table, rowIndex, yColumnIndex));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ rowIndex, x, y });
    }
  }
  return points;
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

function resolveXAxisId(columnIds: readonly string[], xAxisId: string): string {
  return columnIds.includes(xAxisId)
    ? xAxisId
    : columnIds.includes(DEFAULT_X_AXIS_COLUMN_ID)
      ? DEFAULT_X_AXIS_COLUMN_ID
      : (columnIds[0] ?? DEFAULT_X_AXIS_COLUMN_ID);
}

function tableRowsSourceKey(tableId: string): string {
  return DATA_TABLE_ROWS_PATH.replace(
    "{table_id}",
    encodeURIComponent(tableId),
  );
}
