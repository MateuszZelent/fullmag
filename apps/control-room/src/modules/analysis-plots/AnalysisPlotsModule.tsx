"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import type { TableRowsResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  shouldLoadRuntimeScalars,
  useTableColumnsResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import {
  buildTableRowsQuery,
  DEFAULT_TABLE_CHART_COLUMNS,
  type TableRowsLike,
  yAxisIdsAfterXAxisSelection,
} from "./chartTableModel";
import { EChartsSurface } from "./components/EChartsSurface";

const ANALYSIS_SCALAR_COLUMNS = DEFAULT_TABLE_CHART_COLUMNS;
const MAX_VISIBLE_TABLE_ROWS = 5_000;

export default function AnalysisPlotsModule() {
  const { bus, selection } = useKernel();
  const [{ cursor, visibleTable }, dispatchTableResource] = useReducer(
    tableResourceReducer,
    {
      cursor: undefined,
      visibleTable: null,
    } satisfies AnalysisTableState,
  );
  const scalarsRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scalars_revision ?? null,
  );
  const loadScalars = shouldLoadRuntimeScalars(
    true,
    scalarsRevision === null
      ? null
      : { resources: { scalars_revision: scalarsRevision } },
  );

  const [xAxisId, setXAxisIdState] = useState<string>("step");
  const [yAxisIds, setYAxisIds] = useState<string[]>(() =>
    ANALYSIS_SCALAR_COLUMNS.filter((c) => c !== "step"),
  );

  const toggleYAxis = useCallback((columnId: string, enabled: boolean) => {
    setYAxisIds((prev) => {
      if (enabled) {
        return prev.includes(columnId) ? prev : [...prev, columnId];
      }
      return prev.filter((id) => id !== columnId);
    });
  }, []);
  const setXAxisId = useCallback((columnId: string) => {
    setXAxisIdState(columnId);
    setYAxisIds((prev) => yAxisIdsAfterXAxisSelection(prev, columnId));
  }, []);
  const tableQuery = useMemo(
    () =>
      buildTableRowsQuery({
        columns: ANALYSIS_SCALAR_COLUMNS,
        cursor,
        targetPoints: 1_600,
      }),
    [cursor],
  );
  const tableColumns = useTableColumnsResource("default", {
    enabled: loadScalars,
  });
  const tableRows = useTableRowsBinaryResource("default", {
    ...tableQuery,
    enabled: loadScalars,
  });

  useEffect(() => {
    selection.set(
      {
        kind: "analysis.chart",
        label: "Table charts",
        nodeId: "analysis:charts:default",
        objectId: null,
        ref: {
          chartId: "default",
          kind: "analysis.chart",
          nodeId: "analysis:charts:default",
          tableId: "default",
          type: "analysis-chart",
        },
      },
      "analysis-plots",
    );
  }, [selection]);

  useEffect(() => {
    const decoded = tableRows.data;
    const columns = tableColumns.data;
    if (!decoded || decoded.status !== "ready" || !columns) return;
    const resource = tableRowsResourceFromBinary({
      columns,
      decoded: decoded.data,
      queryColumns: ANALYSIS_SCALAR_COLUMNS,
      tableId: "default",
    });
    if (!resource) return;
    dispatchTableResource({ resource, type: "append" });
  }, [tableColumns.data, tableRows.data]);

  useEffect(() => {
    return bus.on("telemetry:scalar-sample", (sample) => {
      const columns = tableColumns.data;
      if (!columns) return;
      const resource = tableRowsResourceFromScalarSample({
        columns,
        queryColumns: ANALYSIS_SCALAR_COLUMNS,
        sample,
        tableId: "default",
      });
      if (!resource) return;
      dispatchTableResource({ resource, type: "append" });
    });
  }, [bus, tableColumns.data]);

  const table = useMemo<TableRowsLike | null>(
    () =>
      visibleTable
        ? {
            columns: visibleTable.columns,
            rows: visibleTable.rows,
          }
        : null,
    [visibleTable],
  );

  return (
    <div className="fm-analysis-plots">
      <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
        <header className="fm-analysis-plots__header">
          <h3>Table charts</h3>
          <span>{formatTableSummary(visibleTable, tableRows.status)}</span>
        </header>
        <EChartsSurface table={table} xAxisId={xAxisId} yAxisIds={yAxisIds} />
        <footer className="fm-analysis-plots__range">
          <span>{visibleTable ? `cursor ${visibleTable.cursor_end}` : "cursor -"}</span>
          <span>{visibleTable ? `${visibleTable.rows.length} visible` : "0 visible"}</span>
        </footer>
      </section>
      <section className="fm-analysis-plots__panel">
        <header className="fm-analysis-plots__header">
          <h3>Columns</h3>
          <span>table/default</span>
        </header>
        <TableColumnList
          onSelectXAxis={setXAxisId}
          onToggleYAxis={toggleYAxis}
          table={visibleTable}
          xAxisId={xAxisId}
          yAxisIds={yAxisIds}
        />
      </section>
    </div>
  );
}

interface AnalysisTableState {
  cursor: number | undefined;
  visibleTable: TableRowsResource | null;
}

type AnalysisTableAction = {
  resource: TableRowsResource;
  type: "append";
};

function tableResourceReducer(
  state: AnalysisTableState,
  action: AnalysisTableAction,
): AnalysisTableState {
  if (action.resource.resync_required) {
    return {
      cursor: undefined,
      visibleTable: trimTableRows(action.resource),
    };
  }
  const visibleTable = mergeTableRows(state.visibleTable, action.resource);
  const cursor =
    state.cursor === action.resource.cursor_end
      ? state.cursor
      : action.resource.cursor_end;
  if (visibleTable === state.visibleTable && cursor === state.cursor) {
    return state;
  }
  return { cursor, visibleTable };
}

function TableColumnList({
  onSelectXAxis,
  onToggleYAxis,
  table,
  xAxisId,
  yAxisIds,
}: {
  onSelectXAxis: (id: string) => void;
  onToggleYAxis: (id: string, enabled: boolean) => void;
  table: TableRowsResource | null;
  xAxisId: string;
  yAxisIds: string[];
}) {
  if (!table) {
    return <div className="fm-analysis-plots__empty">No table schema</div>;
  }
  return (
    <div className="fm-analysis-plots__columns">
      <div className="fm-analysis-plots__column-header">
        <span title="X Axis">X</span>
        <span title="Y Axis">Y</span>
        <span>Name</span>
        <span>Unit</span>
      </div>
      {table.columns.map((column) => (
        <label key={column.column_id} className="fm-analysis-plots__column-row">
          <input
            checked={xAxisId === column.column_id}
            className="fm-analysis-plots__radio"
            name="fm-analysis-x-axis"
            type="radio"
            onChange={() => onSelectXAxis(column.column_id)}
          />
          <input
            checked={yAxisIds.includes(column.column_id)}
            className="fm-analysis-plots__checkbox"
            disabled={xAxisId === column.column_id}
            type="checkbox"
            onChange={(e) => onToggleYAxis(column.column_id, e.target.checked)}
          />
          <span className="fm-analysis-plots__column-label">{column.label}</span>
          <span className="fm-analysis-plots__column-unit">{column.unit}</span>
        </label>
      ))}
    </div>
  );
}

function tableRowsResourceFromBinary({
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

function tableRowsResourceFromScalarSample({
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

function formatTableSummary(
  table: TableRowsResource | null,
  status: string,
): string {
  if (!table) return status;
  return `${table.total_rows} rows / ${table.columns.length} columns`;
}

export const __analysisPlotsTestUtils = {
  analysisScalarColumns: ANALYSIS_SCALAR_COLUMNS,
  defaultTableChartColumns: DEFAULT_TABLE_CHART_COLUMNS,
  tableRowsResourceFromScalarSample,
  tableRowsResourceFromBinary,
  mergeTableRows,
};
