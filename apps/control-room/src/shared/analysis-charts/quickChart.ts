import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  chartTableWindowValue,
  type ChartTableWindow,
} from "@/shared/domain/analysis/chartDataPlan";
import type { ChartRenderModel } from "./chartRenderer";

export interface QuickChartDescriptor {
  chartId: string;
  resourceKey: string;
  tableId: string;
  xAxisId: string;
  yAxisIds: readonly string[];
}

export function quickChartDescriptorFromSelection({
  selection,
  xAxisId,
  yAxisIds,
}: {
  selection: Selection;
  xAxisId: string;
  yAxisIds: readonly string[];
}): QuickChartDescriptor | null {
  const ref = selection.ref;
  if (ref?.type !== "analysis-chart" && ref?.type !== "analysis-chart-point") {
    return null;
  }
  return {
    chartId: ref.chartId,
    resourceKey: `data.table:${ref.tableId}`,
    tableId: ref.tableId,
    xAxisId,
    yAxisIds: [...yAxisIds],
  };
}

export function buildQuickChartRenderModel({
  descriptor,
  status,
  window,
}: {
  descriptor: QuickChartDescriptor;
  status: string;
  window: ChartTableWindow | null;
}): ChartRenderModel {
  const xIndex = window?.columns.findIndex((column) => column.column_id === descriptor.xAxisId) ?? -1;
  const selected = descriptor.yAxisIds.flatMap((id) => {
    const index = window?.columns.findIndex((column) => column.column_id === id) ?? -1;
    return index >= 0 ? [{ id, index, column: window!.columns[index]! }] : [];
  });
  const units = [...new Set(selected.map((entry) => entry.column.unit))].slice(0, 2);
  const renderStatus =
    status === "error" ? "error" :
    status === "loading" || status === "idle" ? "loading" :
    status === "stale" ? "stale" :
    !window || window.rowCount === 0 || xIndex < 0 || selected.length === 0 ? "empty" :
    "ready";
  return {
    ariaLabel: `Quick Chart ${descriptor.chartId}`,
    key: `${descriptor.resourceKey}@${window?.revision ?? "pending"}:${descriptor.xAxisId}:${descriptor.yAxisIds.join(",")}`,
    provenance: {
      dataRevision: window?.revision ?? null,
      decimation: "minmax_lttb",
      query: JSON.stringify({ xAxisId: descriptor.xAxisId, yAxisIds: descriptor.yAxisIds }),
      resourceKey: descriptor.resourceKey,
    },
    series: selected.map((entry) => ({
      id: entry.id,
      kind: "line",
      label: entry.column.label,
      points: Array.from({ length: window?.rowCount ?? 0 }, (_, rowIndex) => ({
        rowIndex,
        x: chartTableWindowValue(window!, rowIndex, xIndex) ?? Number.NaN,
        y: chartTableWindowValue(window!, rowIndex, entry.index) ?? Number.NaN,
      })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      unit: entry.column.unit,
      yAxis: Math.max(0, units.indexOf(entry.column.unit)),
    })),
    status: renderStatus,
    statusMessage:
      renderStatus === "loading" ? "Loading Quick Chart" :
      renderStatus === "error" ? "Quick Chart data unavailable" :
      renderStatus === "empty" ? "No chartable samples for this selection" :
      renderStatus === "stale" ? "Quick Chart data is stale" :
      undefined,
    xAxis: {
      label: window && xIndex >= 0
        ? `${window.columns[xIndex]!.label} [${window.columns[xIndex]!.unit}]`
        : descriptor.xAxisId,
      unit: window && xIndex >= 0 ? window.columns[xIndex]!.unit : "",
    },
    yAxes: (units.length ? units : [""]).map((unit) => ({ label: unit ? `[${unit}]` : "", unit })),
  };
}
