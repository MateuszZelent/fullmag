"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { StudyResultSeriesIdentity } from "@/kernel/api/apiTypes";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  useScalarWindowResource,
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

/**
 * These API queries return a complete filtered window rather than rows after
 * the current cursor. Their cursor bounds can advance between refreshes, so
 * treating the decimated points as an append-only stream can discard updates.
 */
export function shouldReplaceLiveTableSnapshot(range: ChartRangePreference): boolean {
  return range.mode === "fullDecimated" || range.mode === "fixed" || range.mode === "tailTime" || range.mode === "tailRows";
}

export function liveTableSeriesResourceScope(
  identity: StudyResultSeriesIdentity | null | undefined,
): string | undefined {
  if (identity === undefined) return undefined;
  if (identity === null) return "none";
  return JSON.stringify([
    identity.run_id,
    identity.task_id,
    identity.step_id,
    identity.case_id,
    identity.attempt_id,
    identity.ownership_epoch,
  ]);
}

export function liveTableSeriesIdentityFromResource({
  data,
}: {
  data: { series?: StudyResultSeriesIdentity | null } | null;
  status?: string;
}): StudyResultSeriesIdentity | null | undefined {
  return data?.series;
}

export function liveTableForCurrentSeries(
  state: LiveTableStateWithIdentity,
  currentSeries: StudyResultSeriesIdentity | null | undefined,
  queryKey?: string,
): ChartTableWindow | null {
  if (state.legacyWindow) return state.queryKey === queryKey ? state.table : null;
  return responseSeriesMismatch(currentSeries, state.seriesIdentity) ? null : state.table;
}

export function liveTableUnsupportedReason(columns: readonly { column_id: string }[] | null, status: string): string | null {
  return status === "ready" && columns?.length === 0 ? "The active runtime does not publish scalar table samples." : null;
}

export type LiveTableState = { cursor: number | undefined; queryKey: string | null; table: ChartTableWindow | null };
export type LiveTableStateWithIdentity = LiveTableState & {
  legacyWindow?: boolean;
  seriesIdentity?: StudyResultSeriesIdentity | null;
  sessionScopeKey?: string | null;
};

const EMPTY_LIVE_TABLE_STATE: LiveTableStateWithIdentity = {
  cursor: undefined, queryKey: null, table: null,
};

function sameSeriesIdentity(
  left: StudyResultSeriesIdentity | null,
  right: StudyResultSeriesIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.run_id === right.run_id && left.task_id === right.task_id &&
    left.step_id === right.step_id && left.case_id === right.case_id &&
    left.attempt_id === right.attempt_id && left.ownership_epoch === right.ownership_epoch;
}

function responseSeriesMismatch(
  expected: StudyResultSeriesIdentity | null | undefined,
  received: StudyResultSeriesIdentity | null | undefined,
): boolean {
  if (expected === undefined) return false;
  if (received === undefined) return expected !== null;
  return !sameSeriesIdentity(expected, received);
}

export function liveTableReducer(
  state: LiveTableStateWithIdentity,
  next: {
    expectedSeriesIdentity?: StudyResultSeriesIdentity | null;
    queryKey: string;
    replace?: boolean;
    requestCursor?: number;
    seriesIdentity?: StudyResultSeriesIdentity | null;
    sessionScopeKey?: string | null;
    table: ChartTableWindow;
  },
): LiveTableStateWithIdentity {
  if (next.seriesIdentity === undefined) {
    // Older backends cannot attest the owner of a binary response. A bounded
    // cursorless window is useful, but only as a replace-only snapshot.
    return {
      cursor: undefined,
      queryKey: next.queryKey,
      legacyWindow: true,
      sessionScopeKey: next.sessionScopeKey,
      table: next.requestCursor === undefined ? next.table : null,
    };
  }

  const expectedIdentity = next.expectedSeriesIdentity === undefined
    ? next.seriesIdentity : next.expectedSeriesIdentity;
  const mismatch = responseSeriesMismatch(next.expectedSeriesIdentity, next.seriesIdentity);
  const ownerChanged = state.seriesIdentity !== undefined &&
    !sameSeriesIdentity(state.seriesIdentity, expectedIdentity);
  const previousRowsUnbound = state.table !== null && state.seriesIdentity === undefined &&
    expectedIdentity !== null;
  if (mismatch && state.queryKey === next.queryKey &&
      (state.legacyWindow || !responseSeriesMismatch(next.expectedSeriesIdentity, state.seriesIdentity))) {
    return state;
  }
  if (mismatch || (next.requestCursor !== undefined &&
      (ownerChanged || previousRowsUnbound || state.legacyWindow || next.table.resyncRequired))) {
    return {
      cursor: undefined,
      queryKey: next.queryKey,
      seriesIdentity: expectedIdentity,
      sessionScopeKey: next.sessionScopeKey,
      table: null,
    };
  }
  const table = state.queryKey !== next.queryKey || next.replace === true || next.table.resyncRequired ||
    state.legacyWindow || ownerChanged || previousRowsUnbound
    ? next.table
    : mergeChartTableWindows(state.table, next.table);
  const seriesIdentity = next.seriesIdentity;
  const seriesRevision = seriesIdentity ? JSON.stringify([
    liveTableSeriesResourceScope(seriesIdentity), next.queryKey,
    table.revision, table.cursorStart, table.cursorEnd,
  ]) : undefined;
  return {
    cursor: table.cursorEnd,
    queryKey: next.queryKey,
    seriesIdentity,
    sessionScopeKey: next.sessionScopeKey,
    table: table.seriesRevision === seriesRevision ? table : { ...table, seriesRevision },
  };
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
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const resourceEnabled = active && !paused;
  const [stored, dispatch] = useReducer(
    (previous: LiveTableStateWithIdentity, next: Parameters<typeof liveTableReducer>[1] | null) => {
      if (next === null) return EMPTY_LIVE_TABLE_STATE;
      return liveTableReducer(
        previous.sessionScopeKey === next.sessionScopeKey ? previous : EMPTY_LIVE_TABLE_STATE,
        next,
      );
    },
    EMPTY_LIVE_TABLE_STATE,
  );
  const state = resourceEnabled && sessionScopeKey !== null && stored.sessionScopeKey === sessionScopeKey
    ? stored : EMPTY_LIVE_TABLE_STATE;
  if (stored !== state) dispatch(null);

  const tableList = useTableListResource({ enabled: resourceEnabled });
  const table = useTableResource("default", { enabled: resourceEnabled });
  const columns = useTableColumnsResource("default", { enabled: resourceEnabled });
  const scalarWindow = useScalarWindowResource({
    enabled: resourceEnabled,
    limit: 1,
    tail: true,
  });
  const currentSeriesIdentity = liveTableSeriesIdentityFromResource(scalarWindow);
  const seriesResourceScope = liveTableSeriesResourceScope(currentSeriesIdentity);
  const identityQueryScope = seriesResourceScope ?? "unknown";
  const queryColumns = useMemo(() => columns.data?.map((column) => column.column_id) ?? [], [columns.data]);
  const axisAndRange = useMemo(
    () => resolveLiveChartAxisAndRange(queryColumns, xAxisId, range),
    [queryColumns, range, xAxisId],
  );
  const effectiveXAxisId = axisAndRange.xAxisId;
  const effectiveRange = axisAndRange.range;
  const replace = shouldReplaceLiveTableSnapshot(effectiveRange);
  const latestX = state.table && state.table.rowCount > 0
    ? chartTableWindowValue(state.table, state.table.rowCount - 1, state.table.columns.findIndex((column) => column.column_id === effectiveXAxisId)) ?? null
    : null;
  const queryKey = useMemo(() => JSON.stringify({ sessionScopeKey, identity: identityQueryScope, queryColumns, range: effectiveRange, targetPoints, xAxisId: effectiveXAxisId }), [effectiveRange, effectiveXAxisId, identityQueryScope, queryColumns, sessionScopeKey, targetPoints]);
  const query = useMemo(() => buildLiveChartsTableQuery({ columns: queryColumns, cursor: state.queryKey === queryKey ? state.cursor : undefined, latestX: state.queryKey === queryKey ? latestX : null, range: effectiveRange, targetPoints, xAxisId: effectiveXAxisId }), [effectiveRange, effectiveXAxisId, latestX, queryColumns, queryKey, state.cursor, state.queryKey, targetPoints]);
  const hasSchema = queryColumns.length > 0;
  const rows = useTableRowsBinaryResource("default", {
    ...query,
    enabled: shouldLoadLiveTableRows({ active, hasSchema, paused }),
    seriesScope: seriesResourceScope,
  });
  const { data: rowResourceData, refetch: refetchRows } = rows;
  const rejectedBinaryIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resourceEnabled || sessionScopeKey === null) {
      rejectedBinaryIdentityRef.current = null;
      return;
    }
    const decoded = rowResourceData;
    if (!decoded || decoded.status !== "ready" || !columns.data) return;
    const selected = analysisColumnDescriptorsForQuery(columns.data, queryColumns);
    if (selected.length !== decoded.data.columnCount) return;
    const seriesIdentity = decoded.responseMetadata;
    const identityIsStale = seriesIdentity !== undefined && responseSeriesMismatch(currentSeriesIdentity, seriesIdentity);
    dispatch({
      expectedSeriesIdentity: currentSeriesIdentity,
      queryKey,
      replace,
      requestCursor: query.cursor,
      seriesIdentity,
      sessionScopeKey,
      table: chartTableWindowFromBinary({ columns: selected, decoded: decoded.data, tableId: "default" }),
    });
    if (identityIsStale) {
      const staleResponseKey = JSON.stringify([queryKey, decoded.data.revision, seriesIdentity]);
      if (rejectedBinaryIdentityRef.current !== staleResponseKey) {
        rejectedBinaryIdentityRef.current = staleResponseKey;
        refetchRows();
      }
    } else {
      rejectedBinaryIdentityRef.current = null;
    }
  }, [columns.data, currentSeriesIdentity, query.cursor, queryColumns, queryKey, refetchRows, replace, resourceEnabled, rowResourceData, sessionScopeKey]);
  return {
    columns,
    currentSeriesIdentity,
    range: effectiveRange,
    rows,
    sessionScopeKey,
    table: liveTableForCurrentSeries(state, currentSeriesIdentity, queryKey),
    tableList,
    tableResource: table,
    unsupportedReason: liveTableUnsupportedReason(columns.data, columns.status),
    xAxisId: effectiveXAxisId,
  };
}
