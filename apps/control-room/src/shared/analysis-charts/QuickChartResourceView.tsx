"use client";

import { useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useTableColumnsResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useQuickChartWorkspaceSelector } from "@/kernel/workspace/useQuickChartWorkspace";
import {
  analysisColumnDescriptorsForQuery,
  buildSharedAnalysisTableQuery,
  chartTableWindowFromBinary,
} from "@/shared/domain/analysis/chartDataPlan";

import { QuickChartView } from "./QuickChartView";
import {
  buildQuickChartRenderModel,
  quickChartColumnIdsForQuery,
} from "./quickChart";

export function QuickChartResourceView() {
  const kernel = useKernel();
  const pinned = useQuickChartWorkspaceSelector((state) => state.pinned);
  const descriptor = useMemo(
    () => pinned ? { ...pinned, resourceKey: `data.table:${pinned.tableId}` } : null,
    [pinned],
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
  const resourceStatus = !descriptor
    ? "ready"
    : descriptor.selectedSeriesIds.length === 0
      ? "ready"
    : tableColumns.status === "error"
    ? "error"
    : tableColumns.status === "ready" &&
        descriptor.selectedSeriesIds.length > 0 && queryColumns.length === 0
      ? "unsupported"
      : tableColumns.status === "ready"
        ? rows.status
        : tableColumns.status;
  const model = buildQuickChartRenderModel({
    descriptor: descriptor ?? {
      chartId: "none",
      displayUnits: {},
      range: null,
      resourceKey: "data.table:none",
      selectedSeriesIds: [],
      tableId,
      xAxisId: "x",
    },
    status: resourceStatus,
    window,
  });

  if (!descriptor) {
    return (
      <section className="fm-quick-chart" aria-label="Quick Chart">
        <p className="fm-quick-chart__empty" role="status">
          Pin a chart from Analysis
        </p>
      </section>
    );
  }

  return (
    <QuickChartView
      initialRange={descriptor.range}
      model={model}
      onPointSelect={(point) => {
        if (!descriptor) return;
        const rowIndex = (window?.cursorStart ?? 1) + point.rowIndex - 1;
        const quantity = point.seriesId.slice(point.seriesId.lastIndexOf(":") + 1);
        const nodeId = `results:quick-charts:${descriptor.chartId}:point:${point.seriesId}:${rowIndex}`;
        kernel.selection.set({
          kind: "analysis.chart-point",
          label: `${quantity} ${formatQuickChartNumber(point.y)}`,
          nodeId,
          objectId: null,
          ref: {
            chartId: descriptor.chartId,
            kind: "analysis.chart-point",
            nodeId,
            quantity,
            rowIndex,
            seriesId: point.seriesId,
            tableId: descriptor.tableId,
            type: "analysis-chart-point",
            x: point.x,
            y: point.y,
          },
        }, "transport-footer");
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
