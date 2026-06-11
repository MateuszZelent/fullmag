"use client";

import { useEffect, useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import { analysisPlotsWorkspaceStore } from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import {
  shouldLoadRuntimeScalars,
  useSolverEnergyHistoryResource,
  useTableColumnsResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { nextYAxisIdsForToggle } from "@/shared/domain/analysis/TableColumnList";

import type { ChartValueRange } from "./chartTableModel";
import type { ChartSeries } from "./chartTableModel";
import {
  analysisPlotsRangeSelectedEvent,
  analysisPlotsSeriesSelectedEvent,
  buildAnalysisPlotsTableQuery,
  formatAnalysisPointValue,
  resolveAnalysisPlotsRequestedSeriesYAxisIds,
  resolveAnalysisPlotsYAxisIds,
  shouldFetchAnalysisTableRows,
  stringArraysEqual,
} from "./analysisPlotsModel";
import {
  clearChartDispatchSeriesRequest,
  recordChartDispatchSeriesRequest,
  recordChartRangeSelectedEvent,
  recordChartSeriesSelectedEvent,
} from "./components/chartDiagnostics";
import { buildSolverEnergyHistoryChartSeries } from "./energyHistoryAdapter";
import {
  ANALYSIS_SCALAR_COLUMNS,
  tableResourceReducer,
  tableRowsResourceFromBinary,
  tableRowsResourceFromScalarSample,
} from "./tableRowsAdapter";

export function useAnalysisPlotsController(kernel: KernelApi) {
  const { bus, selection } = kernel;
  const { range, tableState, xAxisId, yAxisIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);
  const selectedPoint = useAnalysisPlotsWorkspaceSelector(
    (state) => state.selectedPoint,
  );
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
  const tableQuery = useMemo(
    () => buildAnalysisPlotsTableQuery({ cursor, range, xAxisId }),
    [cursor, range, xAxisId],
  );
  const tableColumns = useTableColumnsResource("default", {
    enabled: loadScalars,
  });
  const tableRows = useTableRowsBinaryResource("default", {
    ...tableQuery,
    enabled: shouldFetchAnalysisTableRows({
      hasVisibleRows: Boolean(visibleTable && visibleTable.rows.length > 0),
      loadScalars,
      range,
    }),
  });
  const solverEnergyHistory = useSolverEnergyHistoryResource(400, {
    enabled: loadScalars,
  });
  const solverEnergySeries = useMemo(
    () =>
      buildSolverEnergyHistoryChartSeries(
        solverEnergyHistory.data,
        solverEnergyHistory.status,
      ),
    [solverEnergyHistory.data, solverEnergyHistory.status],
  );

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
  const setRange = (nextRange: ChartValueRange) => {
    analysisPlotsWorkspaceStore.setRange(nextRange);
    emitRangeSelected(bus, nextRange, xAxisId);
  };
  const clearRange = () => {
    if (range) {
      analysisPlotsWorkspaceStore.setTableState({
        cursor: undefined,
        visibleTable: null,
      });
    }
    analysisPlotsWorkspaceStore.clearRange();
    emitRangeSelected(bus, null, xAxisId);
  };
  const selectPoint = (point: AnalysisChartCursorPoint) => {
    analysisPlotsWorkspaceStore.setSelectedPoint(point);
    selection.set(
      {
        kind: "analysis.chart-point",
        label: `${point.label} ${formatAnalysisPointValue(point.point.y, point.unit)}`,
        nodeId: analysisChartPointNodeId(point),
        objectId: null,
        ref: {
          chartId: point.source.tableId,
          kind: "analysis.chart-point",
          nodeId: analysisChartPointNodeId(point),
          quantity: point.quantity,
          rowIndex: point.point.rowIndex,
          seriesId: point.seriesId,
          tableId: point.source.tableId,
          type: "analysis-chart-point",
          x: point.point.x,
          y: point.point.y,
        },
      },
      "analysis-plots",
    );
  };
  const selectSeries = (series: ChartSeries) => {
    const event = analysisPlotsSeriesSelectedEvent(series);
    bus.emit("charts:series-selected", {
      ...event,
      source: "analysis-plots",
    });
    recordChartSeriesSelectedEvent(event);
  };

  useEffect(() => {
    const columns = tableColumns.data;
    if (!columns) return;
    const sanitized = resolveAnalysisPlotsYAxisIds(yAxisIds, columns, xAxisId);
    if (stringArraysEqual(sanitized, yAxisIds)) return;
    analysisPlotsWorkspaceStore.setAxes(xAxisId, sanitized);
  }, [tableColumns.data, xAxisId, yAxisIds]);

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
    const currentState = analysisPlotsWorkspaceStore.getSnapshot().tableState;
    analysisPlotsWorkspaceStore.setTableState(
      tableResourceReducer(currentState, {
        advanceCursor: range ? false : undefined,
        mode: range ? "replace" : "append",
        resource,
        type: "append",
      }),
    );
  }, [range, tableColumns.data, tableRows.data]);

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
      const currentState = analysisPlotsWorkspaceStore.getSnapshot().tableState;
      analysisPlotsWorkspaceStore.setTableState(
        tableResourceReducer(currentState, {
          advanceCursor: false,
          resource,
          type: "append",
        }),
      );
    });
  }, [bus, tableColumns.data]);

  useEffect(() => {
    return bus.on("charts:add-series-requested", (request) => {
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

  useEffect(() => {
    recordChartDispatchSeriesRequest((columnId) => {
      bus.emit("charts:add-series-requested", {
        columnId,
        source: "analysis-plots",
        tableId: "default",
      });
    });
    return clearChartDispatchSeriesRequest;
  }, [bus]);

  const selectedStageId = useSelectionSelector((state) => {
    if (state.kind === "study.stage.hysteresis" && state.ref?.type === "study-stage") {
      return state.ref.stageId;
    }
    return null;
  });

  return {
    clearRange,
    range,
    selectedPoint,
    selectPoint,
    selectSeries,
    setRange,
    solverEnergySeries,
    solverEnergyStatus: solverEnergyHistory.status,
    setXAxisId,
    tableRowsStatus: tableRows.status,
    toggleYAxis,
    visibleTable,
    xAxisId,
    yAxisIds,
    selectedStageId,
  };
}

function analysisChartPointNodeId(point: AnalysisChartCursorPoint): string {
  return `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
}

function emitRangeSelected(
  bus: KernelApi["bus"],
  range: ChartValueRange | null,
  xAxisId: string,
): void {
  const event = analysisPlotsRangeSelectedEvent({ range, xAxisId });
  bus.emit("charts:range-selected", {
    ...event,
    source: "analysis-plots",
  });
  recordChartRangeSelectedEvent(event);
}
