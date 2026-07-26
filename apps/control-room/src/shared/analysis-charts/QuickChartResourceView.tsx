"use client";

import { useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { useTableRowsBinaryResource } from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  buildSharedAnalysisTableQuery,
  analysisColumnDescriptorsForQuery,
  chartTableWindowFromBinary,
} from "@/shared/domain/analysis/chartDataPlan";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";

import { QuickChartView } from "./QuickChartView";
import {
  buildQuickChartRenderModel,
  quickChartDescriptorFromSelection,
} from "./quickChart";

export function QuickChartResourceView({ selection }: { selection: Selection }) {
  const kernel = useKernel();
  const { availableColumns, xAxisId, yAxisIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);
  const descriptor = quickChartDescriptorFromSelection({ selection, xAxisId, yAxisIds });
  const tableId = descriptor?.tableId ?? "default";
  const query = useMemo(() => buildSharedAnalysisTableQuery(), []);
  const rows = useTableRowsBinaryResource(tableId, { ...query, enabled: Boolean(descriptor) });
  const window = useMemo(() => {
    const decoded = rows.data;
    if (!descriptor || !decoded || decoded.status !== "ready") return null;
    const selectedColumns = analysisColumnDescriptorsForQuery(
      availableColumns,
      query.columns,
    );
    if (selectedColumns.length !== decoded.data.columnCount) return null;
    return chartTableWindowFromBinary({ columns: selectedColumns, decoded: decoded.data, tableId });
  }, [availableColumns, descriptor, query.columns, rows.data, tableId]);
  const model = buildQuickChartRenderModel({
    descriptor: descriptor ?? { chartId: "none", resourceKey: "data.table:none", tableId, xAxisId, yAxisIds },
    status: rows.status,
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
