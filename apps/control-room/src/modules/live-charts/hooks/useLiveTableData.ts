"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import {
  useTableColumnsResource,
  useTableListResource,
  useTableResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { analysisColumnDescriptorsForQuery, chartTableWindowFromBinary, chartTableWindowValue, mergeChartTableWindows } from "@/shared/domain/analysis/chartDataPlan";

import {
  buildLiveChartsTableQuery,
  resolveLiveChartAxisAndRange,
} from "../liveChartsModel";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";

export function shouldLoadLiveTableRows({ active, hasSchema, paused }: { active: boolean; hasSchema: boolean; paused: boolean }): boolean {
  return active && hasSchema && !paused;
}

export function shouldPauseLiveTableRows({ active, hasRows, paused }: { active: boolean; hasRows: boolean; paused: boolean }): boolean {
  return active && paused && hasRows;
}

/**
 * These API queries return a complete filtered window rather than rows after
 * the current cursor. Their cursor bounds can advance between refreshes, so
 * treating the decimated points as an append-only stream can discard updates.
 */
export function shouldReplaceLiveTableSnapshot(range: ChartRangePreference): boolean {
  return range.mode === "fullDecimated" || range.mode === "fixed" || range.mode === "tailTime" || range.mode === "tailRows";
}

export function liveTableUnsupportedReason(columns: readonly { column_id: string }[] | null, status: string): string | null {
  return status === "ready" && columns?.length === 0 ? "The active runtime does not publish scalar table samples." : null;
}

export type LiveTableState = { cursor: number | undefined; queryKey: string | null; table: ChartTableWindow | null };
export function liveTableReducer(state: LiveTableState, next: { queryKey: string; replace?: boolean; table: ChartTableWindow }): LiveTableState {
  const table = state.queryKey !== next.queryKey || next.replace === true || next.table.resyncRequired
    ? next.table
    : mergeChartTableWindows(state.table, next.table);
  return { cursor: table.cursorEnd, queryKey: next.queryKey, table };
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
  const resourceEnabled = active && !paused;
  const tableList = useTableListResource({ enabled: resourceEnabled });
  const table = useTableResource("default", { enabled: resourceEnabled });
  const columns = useTableColumnsResource("default", { enabled: resourceEnabled });
  const [state, append] = useReducer(liveTableReducer, { cursor: undefined, queryKey: null, table: null });
  const queryColumns = useMemo(() => columns.data?.map((column) => column.column_id) ?? [], [columns.data]);
  const axisAndRange = useMemo(
    () => resolveLiveChartAxisAndRange(queryColumns, xAxisId, range),
    [queryColumns, range, xAxisId],
  );
  const effectiveXAxisId = axisAndRange.xAxisId;
  const effectiveRange = axisAndRange.range;
  const latestX = state.table && state.table.rowCount > 0
    ? chartTableWindowValue(state.table, state.table.rowCount - 1, state.table.columns.findIndex((column) => column.column_id === effectiveXAxisId)) ?? null
    : null;
  const queryKey = useMemo(() => JSON.stringify({ queryColumns, range: effectiveRange, targetPoints, xAxisId: effectiveXAxisId }), [effectiveRange, effectiveXAxisId, queryColumns, targetPoints]);
  const query = useMemo(() => buildLiveChartsTableQuery({ columns: queryColumns, cursor: state.queryKey === queryKey ? state.cursor : undefined, latestX: state.queryKey === queryKey ? latestX : null, range: effectiveRange, targetPoints, xAxisId: effectiveXAxisId }), [effectiveRange, effectiveXAxisId, latestX, queryColumns, queryKey, state.cursor, state.queryKey, targetPoints]);
  const hasSchema = queryColumns.length > 0;
  const rows = useTableRowsBinaryResource("default", {
    ...query,
    enabled: shouldLoadLiveTableRows({ active, hasSchema, paused }),
    pauseLoad: shouldPauseLiveTableRows({ active, hasRows: Boolean(state.table?.rowCount), paused }),
  });
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (active && wasPaused.current && !paused && state.table?.revision === rows.revision) {
      rows.refetch();
    }
    wasPaused.current = paused;
  }, [active, paused, rows, state.table?.revision]);
  useEffect(() => {
    const decoded = rows.data;
    if (!decoded || decoded.status !== "ready" || !columns.data) return;
    const selected = analysisColumnDescriptorsForQuery(columns.data, queryColumns);
    if (selected.length !== decoded.data.columnCount) return;
    append({ queryKey, replace: shouldReplaceLiveTableSnapshot(effectiveRange), table: chartTableWindowFromBinary({ columns: selected, decoded: decoded.data, tableId: "default" }) });
  }, [columns.data, effectiveRange, queryColumns, queryKey, rows.data]);
  return { columns, range: effectiveRange, rows, table: state.table, tableList, tableResource: table, unsupportedReason: liveTableUnsupportedReason(columns.data, columns.status), xAxisId: effectiveXAxisId };
}
