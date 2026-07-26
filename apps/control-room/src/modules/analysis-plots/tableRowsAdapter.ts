import type { TableRowsResource } from "@/kernel/api/apiTypes";
import {
  chartTableWindowFromBinary,
  analysisColumnDescriptorsForQuery,
  mergeChartTableWindows,
  type ChartTableWindow,
} from "@/shared/domain/analysis/chartDataPlan";
import { DEFAULT_TABLE_CHART_COLUMNS } from "./chartTableModel";

export { ANALYSIS_CHART_COLUMNS as ANALYSIS_SCALAR_COLUMNS } from "@/shared/domain/analysis/chartDataPlan";
import { ANALYSIS_CHART_COLUMNS as ANALYSIS_SCALAR_COLUMNS } from "@/shared/domain/analysis/chartDataPlan";

export interface AnalysisTableState {
  cursor: number | undefined;
  visibleTable: ChartTableWindow | null;
}

type AnalysisTableAction =
  | { type: "reset" }
  | {
      advanceCursor?: boolean;
      mode?: "append" | "replace";
      resource: ChartTableWindow;
      type: "append";
    };

export function tableResourceReducer(
  state: AnalysisTableState,
  action: AnalysisTableAction,
): AnalysisTableState {
  if (action.type === "reset") {
    return { cursor: undefined, visibleTable: null };
  }
  if (
    (action.resource.resyncRequired || action.mode === "replace") &&
    action.resource.rowCount === 0 &&
    state.visibleTable &&
    state.visibleTable.rowCount > 0
  ) {
    return state;
  }

  if (action.resource.resyncRequired || action.mode === "replace") {
    const cursor =
      action.advanceCursor === false ? state.cursor : action.resource.cursorEnd;
    return {
      cursor,
      visibleTable: action.resource,
    };
  }
  const visibleTable = mergeChartTableWindows(
    state.visibleTable,
    action.resource,
  );
  const cursor =
    action.advanceCursor === false
      ? state.cursor
      : state.cursor === action.resource.cursorEnd
        ? state.cursor
        : action.resource.cursorEnd;
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
}): ChartTableWindow | null {
  const selectedColumns = analysisColumnDescriptorsForQuery(columns, queryColumns);
  if (selectedColumns.length !== decoded.columnCount) return null;
  return chartTableWindowFromBinary({
    columns: selectedColumns,
    decoded,
    tableId,
  });
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
}): ChartTableWindow | null {
  const revision =
    typeof sample.revision === "number"
      ? sample.revision
      : Number(sample.revision);
  if (!Number.isFinite(revision) || revision < 1) return null;
  const selectedColumns = analysisColumnDescriptorsForQuery(columns, queryColumns);
  if (selectedColumns.length === 0) return null;
  return chartTableWindowFromBinary({
    columns: selectedColumns,
    decoded: {
      columnCount: selectedColumns.length,
      cursorEnd: revision,
      cursorStart: revision,
      resyncRequired: false,
      revision,
      rowCount: 1,
      schemaRevision: 1,
      totalRows: revision,
      values: Float64Array.from(
        selectedColumns.map((column) =>
          scalarSampleColumnValue(sample.row, column.column_id),
        ),
      ),
    },
    tableId,
  });
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

export const __analysisTableRowsAdapterTestUtils = {
  analysisScalarColumns: ANALYSIS_SCALAR_COLUMNS,
  defaultTableChartColumns: DEFAULT_TABLE_CHART_COLUMNS,
  tableResourceReducer,
  tableRowsResourceFromScalarSample,
  tableRowsResourceFromBinary,
};
