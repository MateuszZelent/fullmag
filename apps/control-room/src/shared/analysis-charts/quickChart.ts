import {
  chartTableWindowValue,
  type ChartTableWindow,
} from "@/shared/domain/analysis/chartDataPlan";
import {
  chartUnitsCompatible,
  convertChartUnitValue,
} from "@/shared/domain/analysis/chartUnits";
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

export function quickChartUnavailableSeriesIds(
  columns: readonly { column_id: string }[] | null | undefined,
  descriptor: QuickChartDescriptor | null,
): string[] {
  if (!columns || !descriptor) return [];
  const publishedIds = new Set(columns.map((column) => column.column_id));
  return [...new Set(descriptor.selectedSeriesIds)].filter((seriesId) => {
    const columnId = quickChartColumnId(descriptor, seriesId);
    return columnId === null || columnId === descriptor.xAxisId || !publishedIds.has(columnId);
  });
}

export function buildQuickChartRenderModel({
  descriptor,
  status,
  unavailableSeriesIds,
  window,
}: {
  descriptor: QuickChartDescriptor;
  status: string;
  unavailableSeriesIds?: readonly string[];
  window: ChartTableWindow | null;
}): ChartRenderModel {
  const xIndex = window?.columns.findIndex((column) => column.column_id === descriptor.xAxisId) ?? -1;
  const selected = [...new Set(descriptor.selectedSeriesIds)].flatMap((id) => {
    const columnId = quickChartColumnId(descriptor, id);
    const index = window?.columns.findIndex((column) => column.column_id === columnId) ?? -1;
    return index >= 0 ? [{ id, index, column: window!.columns[index]! }] : [];
  });
  const missingSeriesIds = unavailableSeriesIds ?? (window
    ? quickChartUnavailableSeriesIds(window.columns, descriptor)
    : []);
  const unitGroups = groupCompatibleUnits(selected);
  const localUnsupportedMessage = missingSeriesIds.length > 0
    ? `Selected signals are not available in this table: ${missingSeriesIds.map((id) => quickChartColumnId(descriptor, id) ?? id).join(", ")}`
    : unitGroups.length > 2
      ? `Quick Chart supports at most two compatible y-axis unit groups; selected signals use ${unitGroups.length} (${unitGroups.map((group) => group.unit || "1").join(", ")})`
      : null;
  const renderStatus =
    status === "error" ? "error" :
    status === "unsupported" ? "unsupported" :
    status === "loading" || status === "idle" ? "loading" :
    descriptor.selectedSeriesIds.length === 0 ? "empty" :
    localUnsupportedMessage ? "unsupported" :
    status === "stale" ? "stale" :
    !window || window.rowCount === 0 || xIndex < 0 || selected.length === 0 ? "empty" :
    "ready";
  const renderSelected = renderStatus === "unsupported" ? [] : selected;
  return {
    ariaLabel: `Quick Chart ${descriptor.chartId}`,
    key: `${descriptor.resourceKey}@${window?.revision ?? "pending"}:${descriptor.xAxisId}:${descriptor.selectedSeriesIds.join(",")}`,
    provenance: {
      dataRevision: window?.revision ?? null,
      decimation: "minmax_lttb",
      displayUnits: Object.fromEntries(renderSelected.flatMap((entry) => {
        const displayUnit = descriptor.displayUnits[entry.column.column_id] ??
          descriptor.displayUnits[entry.id];
        return displayUnit ? [[`y:${entry.id}`, displayUnit]] : [];
      })),
      query: JSON.stringify({ range: descriptor.range, selectedSeriesIds: descriptor.selectedSeriesIds, xAxisId: descriptor.xAxisId }),
      resourceKey: descriptor.resourceKey,
    },
    series: renderSelected.map((entry) => {
      const yAxis = unitGroups.findIndex((group) =>
        chartUnitsCompatible(group.unit, entry.column.unit),
      );
      const axisUnit = unitGroups[yAxis]?.unit ?? entry.column.unit;
      return {
        id: entry.id,
        kind: "line",
        label: entry.column.label,
        points: Array.from({ length: window?.rowCount ?? 0 }, (_, rowIndex) => {
          const rawY = chartTableWindowValue(window!, rowIndex, entry.index) ?? Number.NaN;
          return {
            rowIndex,
            x: chartTableWindowValue(window!, rowIndex, xIndex) ?? Number.NaN,
            y: convertChartUnitValue(rawY, entry.column.unit, axisUnit),
          };
        }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
        unit: axisUnit,
        yAxis,
      };
    }),
    status: renderStatus,
    statusMessage:
      renderStatus === "loading" ? "Loading Quick Chart" :
      renderStatus === "error" ? "Quick Chart data unavailable" :
      renderStatus === "unsupported" ? localUnsupportedMessage ?? "Selected quantities are not available in this table" :
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
    yAxes: renderStatus === "unsupported" ? [] : (unitGroups.length ? unitGroups : [{ unit: "" }]).map(({ unit }) => ({
      label: [...new Set(renderSelected
        .filter((entry) => chartUnitsCompatible(entry.column.unit, unit))
        .map((entry) => entry.column.label))]
        .join(", "),
      unit,
    })),
  };
}

function groupCompatibleUnits(
  selected: readonly { column: { unit: string } }[],
): Array<{ unit: string }> {
  const groups: Array<{ unit: string }> = [];
  for (const entry of selected) {
    if (!groups.some((group) => chartUnitsCompatible(group.unit, entry.column.unit))) {
      groups.push({ unit: entry.column.unit });
    }
  }
  return groups;
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
