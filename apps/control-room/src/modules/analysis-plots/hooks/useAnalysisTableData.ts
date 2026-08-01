"use client";

/**
 * useAnalysisTableData — resource hook for table (scalar) data.
 *
 * Owns:
 *   - /data-tables/{tableId}/columns   (schema + unit metadata)
 *   - /data-tables/{tableId}/rows      (binary, revisioned, decimated)
 *   - tableState reducer (cursor tracking, append/replace)
 *   - y-axis column sanitization side-effect
 *   - add-series event listener
 *
 * Does NOT own: preferences, range (comes from workspace), liveMode,
 * frequency data, energy data.
 *
 * Etap 10: controller split by resource family.
 * See: docs/analysis-tab-refactoring-plan.md §T10
 */

import { useEffect, useMemo, useReducer } from "react";

import type { KernelApi } from "@/kernel/types";
import { analysisPlotsWorkspaceStore } from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import {
  shouldLoadRuntimeScalars,
  useTableColumnsResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";
import { nextYAxisIdsForToggle } from "@/shared/domain/analysis/TableColumnList";
import type { AxisColumnDescriptor } from "@/shared/domain/analysis/TableColumnList";
import { chartTableWindowValue } from "@/shared/domain/analysis/chartDataPlan";
import type { AnalysisChartRangeMode } from "@/kernel/workspace/analysisPlotsWorkspace";

import type { ChartValueRange } from "../chartTableModel";
import {
  buildAnalysisPlotsTableQuery,
  resolveAnalysisPlotsRequestedSeriesYAxisIds,
  resolveAnalysisPlotsYAxisIds,
  shouldFetchAnalysisTableRows,
  stringArraysEqual,
} from "../analysisPlotsModel";
import {
  clearChartDispatchSeriesRequest,
  recordChartDispatchSeriesRequest,
} from "../components/chartDiagnostics";
import {
  type AnalysisTableState,
  tableResourceReducer,
  tableRowsResourceFromBinary,
} from "../tableRowsAdapter";

export interface AnalysisTableDataResult {
  /** Schema: available columns with labels and units */
  tableColumns: ReturnType<typeof useTableColumnsResource>;
  /** Exact table-autosave quantities published by the runtime. */
  availableColumns: readonly AxisColumnDescriptor[];
  /** Binary rows resource (raw; prefer visibleTable below) */
  tableRows: ReturnType<typeof useTableRowsBinaryResource>;
  /** Accumulated visible table window (cursor-tracked, range-aware) */
  visibleTable: AnalysisTableState["visibleTable"];
  /** Resolved y-axis column IDs from workspace */
  xAxisId: string;
  yAxisIds: readonly string[];
  /** Set which column is the x-axis (also resets y-axis selection) */
  setXAxisId: (columnId: string) => void;
  /** Toggle a y-axis column on/off */
  toggleYAxis: (columnId: string, enabled: boolean) => void;
}

/**
 * The schema resource is the sole authority for a table-autosave query.
 * Until it arrives, the browser must not substitute a guessed set of common
 * quantities: a simulation may publish only a strict subset of them.
 */
export function tableColumnIdsForQuery(
  columns: readonly { column_id: string }[] | null | undefined,
): string[] {
  return columns?.map((column) => column.column_id) ?? [];
}

/** Keep the resource subscribed for revisions after schema publication, even while paused. */
export function shouldLoadPublishedTableRows(
  input: Parameters<typeof shouldFetchAnalysisTableRows>[0],
  hasPublishedTableSchema: boolean,
): boolean {
  return hasPublishedTableSchema && input.loadScalars;
}

/** Freeze payload loading only after a visible revision exists; resume clears this gate. */
export function shouldPausePublishedTableRows(
  input: Parameters<typeof shouldFetchAnalysisTableRows>[0],
  hasPublishedTableSchema: boolean,
): boolean {
  return (
    shouldLoadPublishedTableRows(input, hasPublishedTableSchema) &&
    input.hasVisibleRows &&
    input.liveMode === "paused"
  );
}

/** A paused chart keeps its last visible revision; transport freshness is not a degraded chart state. */
export function tableRowsStatusForDisplay(
  resourceStatus: string,
  liveMode: string,
  hasVisibleRows: boolean,
): string {
  return liveMode === "paused" && hasVisibleRows && resourceStatus !== "error"
    ? "paused"
    : resourceStatus;
}

/**
 * Resource hook: table (scalar) data family.
 *
 * Enabled only when `activeSurface` is one of: overview, dynamics, convergence.
 * Energy and frequency surfaces have their own hooks.
 */
export function useAnalysisTableData(
  kernel: KernelApi,
  {
    activeSurface,
    liveMode,
    range,
    rangeMode,
    targetPoints,
  }: {
    activeSurface: string;
    liveMode: string;
    range: ChartValueRange | null;
    rangeMode: AnalysisChartRangeMode;
    targetPoints: number;
  },
): AnalysisTableDataResult {
  const { bus } = kernel;
  // Keep each selector result referentially stable. Returning a fresh object
  // from getSnapshot makes useSyncExternalStore re-render forever.
  const xAxisId = useAnalysisPlotsWorkspaceSelector((state) => state.xAxisId);
  const yAxisIds = useAnalysisPlotsWorkspaceSelector((state) => state.yAxisIds);

  const [tableState, dispatchTableState] = useReducer(tableResourceReducer, {
    cursor: undefined,
    visibleTable: null,
  } satisfies AnalysisTableState);
  const { cursor, visibleTable } = tableState;

  const scalarsRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scalars_revision ?? null,
  );
  const loadScalars = shouldLoadRuntimeScalars(
    true,
    scalarsRevision === null
      ? null
      : { resources: { scalars_revision: scalarsRevision } },
  );
  const loadTableRows =
    loadScalars &&
    (activeSurface === "overview" ||
      activeSurface === "dynamics" ||
      activeSurface === "convergence");

  const tableColumns = useTableColumnsResource("default", {
    enabled: loadScalars,
  });
  const queryColumns = useMemo(
    () => tableColumnIdsForQuery(tableColumns.data),
    [tableColumns.data],
  );
  const hasPublishedTableSchema = queryColumns.length > 0;

  const latestX = visibleTable && visibleTable.rowCount > 0
    ? chartTableWindowValue(
        visibleTable,
        visibleTable.rowCount - 1,
        visibleTable.columns.findIndex((column) => column.column_id === xAxisId),
      )
    : null;

  const tableQuery = useMemo(
    () => buildAnalysisPlotsTableQuery({
      columns: queryColumns,
      cursor,
      latestX,
      range,
      rangeMode,
      targetPoints,
      xAxisId,
    }),
    [cursor, latestX, queryColumns, range, rangeMode, targetPoints, xAxisId],
  );

  const tableRows = useTableRowsBinaryResource("default", {
    ...tableQuery,
    enabled: shouldLoadPublishedTableRows(
      {
        hasVisibleRows: Boolean(visibleTable && visibleTable.rowCount > 0),
        loadScalars: loadTableRows,
        liveMode: liveMode as import("@/kernel/workspace/analysisPlotsWorkspace").ChartLiveMode,
        range,
      },
      hasPublishedTableSchema,
    ),
    pauseLoad: shouldPausePublishedTableRows(
      {
        hasVisibleRows: Boolean(visibleTable && visibleTable.rowCount > 0),
        loadScalars: loadTableRows,
        liveMode: liveMode as import("@/kernel/workspace/analysisPlotsWorkspace").ChartLiveMode,
        range,
      },
      hasPublishedTableSchema,
    ),
  });

  // Side-effect: sync available columns into workspace store
  useEffect(() => {
    analysisPlotsWorkspaceStore.setAvailableColumns(
      (tableColumns.data ?? []).map((column) => ({
        column_id: column.column_id,
        label: column.label || column.column_id,
        unit: column.unit,
      })),
    );
  }, [tableColumns.data]);

  // Side-effect: sanitize y-axis IDs when columns load
  useEffect(() => {
    const columns = tableColumns.data;
    if (!columns) return;
    const sanitized = resolveAnalysisPlotsYAxisIds(yAxisIds, columns, xAxisId);
    if (stringArraysEqual(sanitized, yAxisIds)) return;
    analysisPlotsWorkspaceStore.setAxes(xAxisId, sanitized);
  }, [tableColumns.data, xAxisId, yAxisIds]);

  // Side-effect: append decoded binary rows into visibleTable
  useEffect(() => {
    const decoded = tableRows.data;
    const columns = tableColumns.data;
    if (!decoded || decoded.status !== "ready" || !columns) return;
    const resource = tableRowsResourceFromBinary({
      columns,
      decoded: decoded.data,
      queryColumns,
      tableId: "default",
    });
    if (!resource) return;
    dispatchTableState({
      advanceCursor: range || rangeMode.mode !== "follow" ? false : undefined,
      mode: range || rangeMode.mode !== "follow" ? "replace" : "append",
      resource,
      type: "append",
    });
  }, [queryColumns, range, rangeMode.mode, tableColumns.data, tableRows.data]);

  // Side-effect: register series-add request dispatcher
  useEffect(() => {
    recordChartDispatchSeriesRequest((columnId) => {
      bus.emit("analysis-plots:add-series-requested", {
        columnId,
        source: "analysis-plots",
        tableId: "default",
      });
    });
    return clearChartDispatchSeriesRequest;
  }, [bus]);

  // Side-effect: handle add-series requests from external sources
  useEffect(() => {
    return bus.on("analysis-plots:add-series-requested", (request) => {
      if (request.tableId !== "default") return;
      const columns = tableColumns.data;
      if (!columns) return;
      const current = analysisPlotsWorkspaceStore.getSnapshot();
      const nextYAxisIds = resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: request.columnId,
        columns,
        xAxisId: current.xAxisId,
        yAxisIds: current.yAxisIds,
      });
      if (stringArraysEqual(nextYAxisIds, current.yAxisIds)) return;
      analysisPlotsWorkspaceStore.setAxes(current.xAxisId, nextYAxisIds);
    });
  }, [bus, tableColumns.data]);

  const setXAxisId = (columnId: string) => {
    analysisPlotsWorkspaceStore.setAxes(
      columnId,
      resolveAnalysisPlotsYAxisIds(
        yAxisIdsAfterXAxisSelection(yAxisIds, columnId),
        tableColumns.data,
        columnId,
      ),
    );
  };

  const toggleYAxis = (columnId: string, enabled: boolean) => {
    analysisPlotsWorkspaceStore.setAxes(
      xAxisId,
      nextYAxisIdsForToggle(yAxisIds, columnId, enabled, {
        columns: tableColumns.data ?? undefined,
        xAxisId,
      }),
    );
  };

  return {
    tableColumns,
    availableColumns: tableColumns.data ?? [],
    tableRows,
    visibleTable,
    xAxisId,
    yAxisIds,
    setXAxisId,
    toggleYAxis,
  };
}
