"use client";

import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { InteractiveChartSurface } from "@/shared/analysis-charts/InteractiveChartSurface";
import { formatChartDisplayValue, createChartDisplayTransform } from "@/shared/analysis-charts/chartScalePolicy";
import type { LiveChartsViewProps } from "../liveChartsViewTypes";

export function LiveChartSurface({ fitRequest, onExport, onRangeSelected, onSeriesChange, presentation, series, selectedSeriesIds, title, xAxisLabel }: Pick<LiveChartsViewProps, "fitRequest" | "onExport" | "onRangeSelected" | "onSeriesChange" | "presentation" | "series" | "selectedSeriesIds" | "title" | "xAxisLabel">) {
  const selected = new Set(selectedSeriesIds);
  const visible = series.filter((item) => selected.has(item.id));
  const legend = series.map((item, index) => ({ colorIndex: index, colorName: chartColorNameForIndex(index), id: item.id, label: item.label || item.quantity, latestValue: formatChartDisplayValue(item.points.at(-1)?.y ?? Number.NaN, createChartDisplayTransform(item.unit, null)), unit: item.unit }));
  return <ChartSection title={title} status={{ presentation, primary: "Live", pointSummary: series[0]?.points.length ? `${series[0].points.length.toLocaleString()} rows` : undefined }} legend={<ChartLegend items={legend} onSelectedSeriesIdsChange={onSeriesChange} selectedSeriesIds={selectedSeriesIds} />}>
    {series.length > 0 && visible.length === 0 ? <div className="fm-live-charts__empty" role="status">Select at least one signal</div> : <InteractiveChartSurface
      allSeries={series} fitRequest={fitRequest} presentation={presentation} series={visible} xAxisLabel={xAxisLabel}
      surface={{ ariaLabel: `${title} live chart`, chartId: `live-charts:${title}:${series.map((item) => `${item.id}:${item.points.length}`).join("|")}`, presentationCopy: { empty: "No live samples", error: "Live samples unavailable", hidden: "All selected series are hidden", loading: "Loading live samples" }, provenance: { dataRevision: series[0]?.dataRevision ?? null, decimation: "minmax_lttb", descriptorId: `live:${title.toLowerCase()}`, query: title, resourceKey: series[0]?.source.resourceKey ?? "data.table:default" } }}
      onExportRequested={onExport} onRangeSelected={onRangeSelected}
    />}
  </ChartSection>;
}
