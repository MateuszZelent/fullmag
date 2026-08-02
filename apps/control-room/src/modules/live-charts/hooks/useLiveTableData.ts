"use client";

import { useEffect, useMemo, useReducer } from "react";

import {
  useTableColumnsResource,
  useTableListResource,
  useTableResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { analysisColumnDescriptorsForQuery, chartTableWindowFromBinary, chartTableWindowValue, mergeChartTableWindows } from "@/shared/domain/analysis/chartDataPlan";

import { buildLiveChartsTableQuery } from "../liveChartsModel";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";

export function shouldLoadLiveTableRows({ active, hasSchema, paused }: { active: boolean; hasSchema: boolean; paused: boolean }): boolean {
  return active && hasSchema && !paused;
}

export function shouldPauseLiveTableRows({ active, hasRows, paused }: { active: boolean; hasRows: boolean; paused: boolean }): boolean {
  return active && paused && hasRows;
}

export function liveTableUnsupportedReason(columns: readonly { column_id: string }[] | null, status: string): string | null {
  return status === "ready" && columns?.length === 0 ? "The active runtime does not publish scalar table samples." : null;
}

type TableState = { cursor: number | undefined; table: ChartTableWindow | null };
function tableReducer(state: TableState, next: ChartTableWindow): TableState {
  const table = next.resyncRequired ? next : mergeChartTableWindows(state.table, next);
  return { cursor: table.cursorEnd, table };
}

export function useLiveTableData({
  active,
  paused,
  range,
  targetPoints,
  xAxisId,
}: {
  active: boolean;
  paused: boolean;
  range: ChartRangePreference;
  targetPoints: number;
  xAxisId: string;
}) {
  const tableList = useTableListResource({ enabled: active });
  const table = useTableResource("default", { enabled: active });
  const columns = useTableColumnsResource("default", { enabled: active });
  const [state, append] = useReducer(tableReducer, { cursor: undefined, table: null });
  const queryColumns = useMemo(() => columns.data?.map((column) => column.column_id) ?? [], [columns.data]);
  const latestX = state.table && state.table.rowCount > 0
    ? chartTableWindowValue(state.table, state.table.rowCount - 1, state.table.columns.findIndex((column) => column.column_id === xAxisId)) ?? null
    : null;
  const query = useMemo(() => buildLiveChartsTableQuery({ columns: queryColumns, cursor: state.cursor, latestX, range, targetPoints, xAxisId }), [latestX, queryColumns, range, state.cursor, targetPoints, xAxisId]);
  const hasSchema = queryColumns.length > 0;
  const rows = useTableRowsBinaryResource("default", {
    ...query,
    enabled: shouldLoadLiveTableRows({ active, hasSchema, paused }),
    pauseLoad: shouldPauseLiveTableRows({ active, hasRows: Boolean(state.table?.rowCount), paused }),
  });
  useEffect(() => {
    const decoded = rows.data;
    if (!decoded || decoded.status !== "ready" || !columns.data) return;
    const selected = analysisColumnDescriptorsForQuery(columns.data, queryColumns);
    if (selected.length !== decoded.data.columnCount) return;
    append(chartTableWindowFromBinary({ columns: selected, decoded: decoded.data, tableId: "default" }));
  }, [columns.data, queryColumns, rows.data]);
  return { columns, rows, table: state.table, tableList, tableResource: table, unsupportedReason: liveTableUnsupportedReason(columns.data, columns.status) };
}
