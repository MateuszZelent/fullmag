import { chartColorNameForIndex, type ChartLegendItem } from "@/shared/analysis-charts/ChartLegend";
import { createChartDisplayTransform, formatChartDisplayValue } from "@/shared/analysis-charts/chartScalePolicy";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { compatibleLiveChartPanes } from "./liveChartsModel";
import { chartSeriesRenderModel } from "@/shared/analysis-charts/InteractiveChartSurface";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";

export function liveChartExportModel(series: readonly ChartSeries[], title: string, xAxisLabel: string, presentation: ChartDataPresentationState) {
  const model = chartSeriesRenderModel(series, series, {
    ariaLabel: `${title} live chart`,
    chartId: `live-charts:${title}:signals`,
    presentationCopy: { empty: "No live samples", error: "Live samples unavailable", loading: "Loading live samples" },
    provenance: { dataRevision: series[0]?.dataRevision ?? null, decimation: "minmax_lttb", descriptorId: `live:${title.toLowerCase()}`, query: title, resourceKey: series[0]?.source.resourceKey ?? "data.table:default" },
  }, xAxisLabel, undefined, presentation);
  const panes = compatibleLiveChartPanes(series);
  // The data export contains all selected unit families; each is still rendered separately.
  return {
    ...model,
    series: model.series.map((item) => ({ ...item, yAxis: panes.findIndex((pane) => pane.unit === item.unit) })),
    yAxes: panes.map((pane) => ({ label: pane.label, unit: pane.unit })),
  };
}

export function liveChartXAxisOptions(columns: readonly { column_id: string; label: string; unit: string }[], currentId: string) {
  const axisIds = new Set(["step", "t", "time", currentId]);
  return columns.reduce<{ id: string; label: string }[]>((options, column) => {
    if (!axisIds.has(column.column_id)) return options;
    options.push({
      id: column.column_id,
      label: column.column_id === "step" ? "Step" : column.column_id === "t" || column.column_id === "time" ? `Time (${column.unit})` : `${column.label}${column.unit && column.unit !== "1" ? ` (${column.unit})` : ""}`,
    });
    return options;
  }, []);
}

export function visibleLiveChartPanes(series: readonly ChartSeries[], selectedSeriesIds: readonly string[]) {
  const selected = new Set(selectedSeriesIds);
  return compatibleLiveChartPanes(series).filter((pane) => pane.seriesIds.some((id) => selected.has(id)));
}

export function liveChartReadings(series: readonly ChartSeries[]): ChartLegendItem[] {
  const unitIndices = new Map<string, number>();
  return series.map((item) => {
    // Each unit pane owns its palette; selection and search never renumber it.
    const colorIndex = unitIndices.get(item.unit) ?? 0;
    unitIndices.set(item.unit, colorIndex + 1);
    const value = item.points.at(-1)?.y ?? Number.NaN;
    const magnitude = Math.abs(value);
    const transform = createChartDisplayTransform(item.unit, Number.isFinite(value) && magnitude > 0 ? [magnitude, magnitude] : null);
    return {
      colorIndex,
      colorName: chartColorNameForIndex(colorIndex),
      id: item.id,
      label: item.label || item.quantity,
      latestValue: formatChartDisplayValue(value, transform),
      unit: transform.displayUnit || (item.unit === "1" ? "1" : item.unit),
    };
  });
}
