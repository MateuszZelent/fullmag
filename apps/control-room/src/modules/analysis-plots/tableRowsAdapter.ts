import type { TableRowsResource } from "@/kernel/api/apiTypes";
import type { AnalysisTableState } from "@/kernel/workspace/analysisPlotsWorkspace";

import { DEFAULT_TABLE_CHART_COLUMNS } from "./chartTableModel";

export const ANALYSIS_SCALAR_COLUMNS = DEFAULT_TABLE_CHART_COLUMNS;

const MAX_VISIBLE_TABLE_ROWS = 5_000;

type AnalysisTableAction = {
  advanceCursor?: boolean;
  mode?: "append" | "replace";
  resource: TableRowsResource;
  type: "append";
};

export function tableResourceReducer(
  state: AnalysisTableState,
  action: AnalysisTableAction,
): AnalysisTableState {
  if (
    (action.resource.resync_required || action.mode === "replace") &&
    action.resource.rows.length === 0 &&
    state.visibleTable &&
    state.visibleTable.rows.length > 0
  ) {
    return state;
  }

  if (action.resource.resync_required || action.mode === "replace") {
    const cursor =
      action.advanceCursor === false ? state.cursor : action.resource.cursor_end;
    return {
      cursor,
      visibleTable: trimTableRows(action.resource),
    };
  }
  const visibleTable = mergeTableRows(state.visibleTable, action.resource);
  const cursor =
    action.advanceCursor === false
      ? state.cursor
      :
    state.cursor === action.resource.cursor_end
      ? state.cursor
      : action.resource.cursor_end;
  if (visibleTable === state.visibleTable && cursor === state.cursor) {
    return state;
  }
  return { cursor, visibleTable };
}

export function tableRowsResourceFromBinary({
  columns,
  decoded,
  queryColumns,
  tableId,
}: {
  columns: readonly TableRowsResource["columns"][number][];
  decoded: {
    columnCount: number;
    cursorEnd: number;
    cursorStart: number;
    resyncRequired: boolean;
    revision: number;
    rowCount: number;
    schemaRevision: number;
    totalRows: number;
    values: Float64Array;
  };
  queryColumns: readonly string[];
  tableId: string;
}): TableRowsResource | null {
  const selectedColumns = columnsForQuery(columns, queryColumns);
  if (selectedColumns.length !== decoded.columnCount) return null;
  const rows: number[][] = [];
  for (let rowIndex = 0; rowIndex < decoded.rowCount; rowIndex++) {
    const start = rowIndex * decoded.columnCount;
    rows.push(
      Array.from(
        decoded.values.subarray(start, start + decoded.columnCount),
      ),
    );
  }

  return {
    columns: selectedColumns,
    cursor_end: decoded.cursorEnd,
    cursor_start: decoded.cursorStart,
    decimation: null,
    resync_required: decoded.resyncRequired,
    returned_rows: decoded.rowCount,
    revision: decoded.revision,
    rows,
    schema_revision: decoded.schemaRevision,
    table_id: tableId,
    total_rows: decoded.totalRows,
  };
}

export function tableRowsResourceFromScalarSample({
  columns,
  queryColumns,
  sample,
  tableId,
}: {
  columns: readonly TableRowsResource["columns"][number][];
  queryColumns: readonly string[];
  sample: {
    revision: string | number;
    row: Record<string, number>;
  };
  tableId: string;
}): TableRowsResource | null {
  const revision =
    typeof sample.revision === "number"
      ? sample.revision
      : Number(sample.revision);
  if (!Number.isFinite(revision) || revision < 1) return null;
  const selectedColumns = columnsForQuery(columns, queryColumns);
  if (selectedColumns.length === 0) return null;
  return {
    columns: selectedColumns,
    cursor_end: revision,
    cursor_start: revision,
    decimation: null,
    resync_required: false,
    returned_rows: 1,
    revision,
    rows: [
      selectedColumns.map((column) =>
        scalarSampleColumnValue(sample.row, column.column_id),
      ),
    ],
    schema_revision: 1,
    table_id: tableId,
    total_rows: revision,
  };
}

function columnsForQuery(
  columns: readonly TableRowsResource["columns"][number][],
  queryColumns: readonly string[],
): TableRowsResource["columns"] {
  const byId = new Map(columns.map((column) => [column.column_id, column]));
  return queryColumns
    .map((columnId) => byId.get(columnId))
    .filter((column): column is TableRowsResource["columns"][number] =>
      Boolean(column),
    );
}

function scalarSampleColumnValue(
  row: Record<string, number>,
  columnId: string,
): number {
  switch (columnId) {
    case "t":
    case "time":
      return row.time ?? 0;
    case "dt":
    case "solver_dt":
      return row.solver_dt ?? row.dt ?? 0;
    case "max_torque":
      return row.max_torque_Apm ?? row.max_torque ?? 0;
    default:
      return row[columnId] ?? 0;
  }
}

function mergeTableRows(
  current: TableRowsResource | null,
  incoming: TableRowsResource,
): TableRowsResource {
  if (
    !current ||
    incoming.resync_required ||
    incoming.cursor_start <= 1 ||
    !sameColumns(current, incoming)
  ) {
    return trimTableRows(incoming);
  }
  const overlap = Math.max(0, current.cursor_end - incoming.cursor_start + 1);
  const incomingRows =
    overlap > 0 ? incoming.rows.slice(overlap) : incoming.rows;
  if (incomingRows.length === 0) {
    return current;
  }

  return trimTableRows({
    ...incoming,
    columns: current.columns,
    cursor_start: current.cursor_start,
    returned_rows: Math.min(
      current.rows.length + incomingRows.length,
      MAX_VISIBLE_TABLE_ROWS,
    ),
    rows: [...current.rows, ...incomingRows],
  });
}

function trimTableRows(table: TableRowsResource): TableRowsResource {
  if (table.rows.length <= MAX_VISIBLE_TABLE_ROWS) {
    return table;
  }

  const rows = table.rows.slice(-MAX_VISIBLE_TABLE_ROWS);
  return {
    ...table,
    cursor_start: table.cursor_end - rows.length + 1,
    returned_rows: rows.length,
    rows,
  };
}

function sameColumns(left: TableRowsResource, right: TableRowsResource): boolean {
  return (
    left.columns.length === right.columns.length &&
    left.columns.every(
      (column, index) => column.column_id === right.columns[index]?.column_id,
    )
  );
}

export const __analysisTableRowsAdapterTestUtils = {
  analysisScalarColumns: ANALYSIS_SCALAR_COLUMNS,
  defaultTableChartColumns: DEFAULT_TABLE_CHART_COLUMNS,
  tableResourceReducer,
  tableRowsResourceFromScalarSample,
  tableRowsResourceFromBinary,
  mergeTableRows,
};
