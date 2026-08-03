import {
  chartTableWindowValue,
  type ChartTableWindow,
} from "@/shared/domain/analysis/chartDataPlan";
import type { ChartRenderModel } from "./chartRenderer";

export interface QuickChartDescriptor {
  chartId: string;
  displayUnits: Record<string, string>;
  range: { fromSI: number; toSI: number } | null;
  resourceKey: string;
  selectedSeriesIds: readonly string[];
  tableId: string;
  xAxisId: string;
}

/**
 * The Quick Chart must make the same schema-first promise as the full
 * Analysis workbench: never request a guessed, static quantity list.
 */
export function quickChartColumnIdsForQuery(
  columns: readonly { column_id: string }[] | null | undefined,
  descriptor: QuickChartDescriptor | null,
): string[] {
  if (!columns || !descriptor) return [];
  const publishedIds = new Set(columns.map((column) => column.column_id));
  if (!publishedIds.has(descriptor.xAxisId)) return [];
  const selectedColumnIds = [...new Set(descriptor.selectedSeriesIds)]
    .map((seriesId) => quickChartColumnId(descriptor, seriesId))
    .filter((columnId): columnId is string =>
      columnId !== null && columnId !== descriptor.xAxisId && publishedIds.has(columnId),
    );
  return selectedColumnIds.length > 0
    ? [descriptor.xAxisId, ...selectedColumnIds]
    : [];
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
  const selected = [...new Set(descriptor.selectedSeriesIds)].flatMap((id) => {
    const columnId = quickChartColumnId(descriptor, id);
    const index = window?.columns.findIndex((column) => column.column_id === columnId) ?? -1;
    return index >= 0 ? [{ id, index, column: window!.columns[index]! }] : [];
  });
  const units = [...new Set(selected.map((entry) => entry.column.unit))].slice(0, 2);
  const renderStatus =
    status === "error" ? "error" :
    status === "unsupported" ? "unsupported" :
    status === "loading" || status === "idle" ? "loading" :
    status === "stale" ? "stale" :
    descriptor.selectedSeriesIds.length === 0 ? "empty" :
    !window || window.rowCount === 0 || xIndex < 0 || selected.length === 0 ? "empty" :
    "ready";
  return {
    ariaLabel: `Quick Chart ${descriptor.chartId}`,
    key: `${descriptor.resourceKey}@${window?.revision ?? "pending"}:${descriptor.xAxisId}:${descriptor.selectedSeriesIds.join(",")}`,
    provenance: {
      dataRevision: window?.revision ?? null,
      decimation: "minmax_lttb",
      displayUnits: Object.fromEntries(selected.flatMap((entry) => {
        const displayUnit = descriptor.displayUnits[entry.column.column_id] ??
          descriptor.displayUnits[entry.id];
        return displayUnit ? [[`y:${entry.id}`, displayUnit]] : [];
      })),
      query: JSON.stringify({ range: descriptor.range, selectedSeriesIds: descriptor.selectedSeriesIds, xAxisId: descriptor.xAxisId }),
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
      renderStatus === "unsupported" ? "Selected quantities are not available in this table" :
      renderStatus === "empty" && descriptor.selectedSeriesIds.length === 0 ? "Select at least one signal" :
      renderStatus === "empty" ? "No chartable samples for this selection" :
      renderStatus === "stale" ? "Quick Chart data is stale" :
      undefined,
    xAxis: {
      label: window && xIndex >= 0
        ? `${window.columns[xIndex]!.label} [${window.columns[xIndex]!.unit}]`
        : descriptor.xAxisId,
      unit: window && xIndex >= 0 ? window.columns[xIndex]!.unit : "",
    },
    yAxes: (units.length ? units : [""]).map((unit) => ({
      label: [...new Set(selected
        .filter((entry) => entry.column.unit === unit)
        .map((entry) => entry.column.label))]
        .join(", "),
      unit,
    })),
  };
}

function quickChartColumnId(
  descriptor: QuickChartDescriptor,
  seriesId: string,
): string | null {
  const prefix = `data.table:${descriptor.tableId}:${descriptor.xAxisId}:`;
  return seriesId.startsWith(prefix) && seriesId.length > prefix.length
    ? seriesId.slice(prefix.length)
    : null;
}
