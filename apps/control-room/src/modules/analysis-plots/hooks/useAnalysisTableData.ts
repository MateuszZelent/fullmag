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
import {
  isTableChartSeriesId,
  replaceSelectedSeriesIdsInScope,
  sanitizeSelectedSeriesIds,
  tableChartSeriesId,
} from "@/shared/analysis-charts/chartSeriesSelection";
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
  /** Semantic availability of table samples, derived from the published schema. */
  tableRowsUnsupportedReason: string | null;
  /** Accumulated visible table window (cursor-tracked, range-aware) */
  visibleTable: AnalysisTableState["visibleTable"];
  /** Selected chart-series IDs from workspace */
  xAxisId: string;
  selectedSeriesIds: readonly string[];
  /** Set which column is the x-axis (also resets y-axis selection) */
  setXAxisId: (columnId: string) => void;
  setSelectedSeriesIds: (selectedSeriesIds: readonly string[]) => void;
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

/** A published empty schema means the active runtime has no scalar table capability. */
export function tableRowsUnsupportedReasonForColumns(
  columns: readonly { column_id: string }[] | null | undefined,
  status: string,
): string | null {
  return status === "ready" && columns?.length === 0
    ? "The active runtime does not publish scalar table samples."
    : null;
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
    onTableSelectionChange,
    onTableXAxisChange,
  }: {
    activeSurface: string;
    liveMode: string;
    range: ChartValueRange | null;
    rangeMode: AnalysisChartRangeMode;
    targetPoints: number;
    onTableSelectionChange: (selectedSeriesIds: readonly string[]) => void;
    onTableXAxisChange: (
      xAxisId: string,
      selectedSeriesIds: readonly string[],
    ) => void;
  },
): AnalysisTableDataResult {
  const { bus } = kernel;
  // Keep each selector result referentially stable. Returning a fresh object
  // from getSnapshot makes useSyncExternalStore re-render forever.
  const xAxisId = useAnalysisPlotsWorkspaceSelector((state) => state.xAxisId);
  const selectedSeriesIds = useAnalysisPlotsWorkspaceSelector((state) => state.selectedSeriesIds);

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
  const tableRowsUnsupportedReason = tableRowsUnsupportedReasonForColumns(
    tableColumns.data,
    tableColumns.status,
  );

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

  // Side-effect: remove unavailable table IDs without touching other surfaces.
  useEffect(() => {
    const columns = tableColumns.data;
    if (!columns) return;
    const sanitizedTableIds = tableSeriesIdsForColumnIds(
      resolveAnalysisPlotsYAxisIds(
        selectedColumnIds(selectedSeriesIds, columns, xAxisId),
        columns,
        xAxisId,
      ),
      xAxisId,
    );
    const sanitized = replaceSelectedSeriesIdsInScope(
      selectedSeriesIds,
      sanitizedTableIds,
      isTableChartSeriesId,
    );
    if (stringArraysEqual(sanitized, selectedSeriesIds)) return;
    onTableSelectionChange(sanitized);
  }, [onTableSelectionChange, selectedSeriesIds, tableColumns.data, xAxisId]);

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
      const nextColumnIds = resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: request.columnId,
        columns,
        xAxisId: current.xAxisId,
        yAxisIds: selectedColumnIds(current.selectedSeriesIds, columns, current.xAxisId),
      });
      const nextSelectedSeriesIds = replaceSelectedSeriesIdsInScope(
        current.selectedSeriesIds,
        tableSeriesIdsForColumnIds(nextColumnIds, current.xAxisId),
        isTableChartSeriesId,
      );
      if (stringArraysEqual(nextSelectedSeriesIds, current.selectedSeriesIds)) return;
      onTableSelectionChange(nextSelectedSeriesIds);
    });
  }, [bus, onTableSelectionChange, tableColumns.data]);

  const setXAxisId = (columnId: string) => {
    const nextSelectedSeriesIds = replaceSelectedSeriesIdsInScope(
      analysisPlotsWorkspaceStore.getSnapshot().selectedSeriesIds,
      tableSeriesIdsForColumnIds(resolveAnalysisPlotsYAxisIds(
        yAxisIdsAfterXAxisSelection(
          selectedColumnIds(selectedSeriesIds, tableColumns.data ?? [], xAxisId),
          columnId,
        ),
        tableColumns.data,
        columnId,
      ), columnId),
      isTableChartSeriesId,
    );
    onTableXAxisChange(columnId, nextSelectedSeriesIds);
  };

  const setSelectedSeriesIds = (nextSelectedSeriesIds: readonly string[]) => {
    const columns = tableColumns.data;
    const current = analysisPlotsWorkspaceStore.getSnapshot();
    onTableSelectionChange(replaceSelectedSeriesIdsInScope(
      current.selectedSeriesIds,
      columns
        ? sanitizeSelectedSeriesIds(
            nextSelectedSeriesIds,
            tableSeriesIdsForColumns(columns, xAxisId),
          )
        : nextSelectedSeriesIds.filter(isTableChartSeriesId),
      isTableChartSeriesId,
    ));
  };

  return {
    tableColumns,
    availableColumns: tableColumns.data ?? [],
    tableRows,
    tableRowsUnsupportedReason,
    visibleTable,
    xAxisId,
    selectedSeriesIds,
    setXAxisId,
    setSelectedSeriesIds,
  };
}

function tableSeriesIdsForColumns(
  columns: readonly { column_id: string }[],
  xAxisId: string,
): string[] {
  return columns
    .filter((column) => column.column_id !== xAxisId)
    .map((column) => tableChartSeriesId("default", xAxisId, column.column_id));
}

function tableSeriesIdsForColumnIds(
  columnIds: readonly string[],
  xAxisId: string,
): string[] {
  return columnIds.map((columnId) => tableChartSeriesId("default", xAxisId, columnId));
}

function selectedColumnIds(
  selectedSeriesIds: readonly string[],
  columns: readonly { column_id: string }[],
  xAxisId: string,
): string[] {
  return columns.flatMap((column) =>
    selectedSeriesIds.includes(tableChartSeriesId("default", xAxisId, column.column_id))
      ? [column.column_id]
      : [],
  );
}
