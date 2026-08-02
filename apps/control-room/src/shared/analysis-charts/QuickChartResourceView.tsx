"use client";

import { useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useTableColumnsResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  analysisColumnDescriptorsForQuery,
  buildSharedAnalysisTableQuery,
  chartTableWindowFromBinary,
} from "@/shared/domain/analysis/chartDataPlan";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import { tableColumnIdFromSeriesId } from "./chartSeriesSelection";

import { QuickChartView } from "./QuickChartView";
import {
  buildQuickChartRenderModel,
  quickChartColumnIdsForQuery,
  quickChartDescriptorFromSelection,
} from "./quickChart";

export function QuickChartResourceView({ selection }: { selection: Selection }) {
  const kernel = useKernel();
  const { xAxisId, selectedSeriesIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);
  const yAxisIds = selectedSeriesIds.map(tableColumnIdFromSeriesId);
  const descriptor = useMemo(
    () => quickChartDescriptorFromSelection({ selection, xAxisId, yAxisIds }),
    [selection, xAxisId, yAxisIds],
  );
  const tableId = descriptor?.tableId ?? "default";
  const tableColumns = useTableColumnsResource(tableId, {
    enabled: Boolean(descriptor),
  });
  const queryColumns = useMemo(
    () => quickChartColumnIdsForQuery(tableColumns.data, descriptor),
    [descriptor, tableColumns.data],
  );
  const query = useMemo(
    () => buildSharedAnalysisTableQuery({ columns: queryColumns }),
    [queryColumns],
  );
  const rows = useTableRowsBinaryResource(tableId, {
    ...query,
    enabled: queryColumns.length > 0,
  });
  const window = useMemo(() => {
    const decoded = rows.data;
    if (!descriptor || !decoded || decoded.status !== "ready") return null;
    const columns = analysisColumnDescriptorsForQuery(
      tableColumns.data ?? [],
      queryColumns,
    );
    if (columns.length !== decoded.data.columnCount) return null;
    return chartTableWindowFromBinary({ columns, decoded: decoded.data, tableId });
  }, [descriptor, queryColumns, rows.data, tableColumns.data, tableId]);
  const resourceStatus = tableColumns.status === "error"
    ? "error"
    : tableColumns.status === "ready" && queryColumns.length === 0
      ? "unsupported"
      : tableColumns.status === "ready"
        ? rows.status
        : tableColumns.status;
  const model = buildQuickChartRenderModel({
    descriptor: descriptor ?? { chartId: "none", resourceKey: "data.table:none", tableId, xAxisId, yAxisIds },
    status: resourceStatus,
    window,
  });

  return (
    <QuickChartView
      model={model}
      onPointSelect={(point) => {
        if (!descriptor) return;
        const rowIndex = (window?.cursorStart ?? 1) + point.rowIndex - 1;
        const nodeId = `analysis:charts:${descriptor.tableId}:point:${point.seriesId}:${rowIndex}`;
        kernel.selection.set({
          kind: "analysis.chart-point",
          label: `${point.seriesId} ${formatQuickChartNumber(point.y)}`,
          nodeId,
          objectId: null,
          ref: {
            chartId: descriptor.chartId,
            kind: "analysis.chart-point",
            nodeId,
            quantity: point.seriesId,
            rowIndex,
            seriesId: point.seriesId,
            tableId: descriptor.tableId,
            type: "analysis-chart-point",
            x: point.x,
            y: point.y,
          },
        }, "analysis-plots");
      }}
    />
  );
}

function formatQuickChartNumber(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(6);
  }
  return Number.isInteger(value) ? String(value) : value.toPrecision(7);
}
