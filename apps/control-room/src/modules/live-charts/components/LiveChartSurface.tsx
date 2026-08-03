"use client";

import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { InteractiveChartSurface } from "@/shared/analysis-charts/InteractiveChartSurface";
import { formatChartDisplayValue, createChartDisplayTransform } from "@/shared/analysis-charts/chartScalePolicy";
import { compatibleLiveChartPanes } from "../liveChartsModel";
import type { LiveChartsViewProps } from "../liveChartsViewTypes";

export function LiveChartSurface({ fitRequest, onChartSelected, onExport, onPointSelected, onRangeSelected, onRequestedExportHandled, onSeriesChange, presentation, requestedExportFormat, series, selectedSeriesIds, title, xAxisLabel }: Pick<LiveChartsViewProps, "fitRequest" | "onChartSelected" | "onExport" | "onPointSelected" | "onRangeSelected" | "onRequestedExportHandled" | "onSeriesChange" | "presentation" | "requestedExportFormat" | "series" | "selectedSeriesIds" | "title" | "xAxisLabel">) {
  const selected = new Set(selectedSeriesIds);
  const panes = compatibleLiveChartPanes(series);
  if (panes.length === 0) {
    return (
      <div className="fm-live-charts__panes">
        <ChartSection title={title} status={{ presentation, primary: "Live" }}>
          <div className="fm-live-charts__empty" role="status">
            {emptySeriesMessage(presentation)}
          </div>
        </ChartSection>
      </div>
    );
  }
  return <div className="fm-live-charts__panes">{panes.map((pane) => {
    const paneSeries = series.filter((item) => pane.seriesIds.includes(item.id));
    const visible = paneSeries.filter((item) => selected.has(item.id));
    const legend = paneSeries.map((item, index) => ({ colorIndex: index, colorName: chartColorNameForIndex(index), id: item.id, label: item.label || item.quantity, latestValue: formatChartDisplayValue(item.points.at(-1)?.y ?? Number.NaN, createChartDisplayTransform(item.unit, null)), unit: item.unit }));
    const panelTitle = panes.length > 1 ? `${title} — ${pane.label}` : title;
    const revision = paneSeries.find((item) => item.dataRevision != null)?.dataRevision ?? presentationRevision(presentation);
    return <ChartSection key={pane.unit} title={panelTitle} status={{ presentation, primary: "Live", pointSummary: paneSeries[0]?.points.length ? `${paneSeries[0].points.length.toLocaleString()} rows` : undefined }} legend={<ChartLegend items={legend} onSelectedSeriesIdsChange={(ids) => { onChartSelected(); onSeriesChange(ids); }} selectedSeriesIds={selectedSeriesIds} />}>
      {paneSeries.length > 0 && visible.length === 0 ? <div className="fm-live-charts__empty" role="status">Select at least one signal</div> : <InteractiveChartSurface
        allSeries={paneSeries} fitRequest={fitRequest} presentation={presentation} requestedExportFormat={requestedExportFormat} series={visible} xAxisLabel={xAxisLabel}
        surface={{ ariaLabel: `${panelTitle} live chart`, chartId: `live-charts:${panelTitle}:${paneSeries.map((item) => `${item.id}:${item.points.length}`).join("|")}`, presentationCopy: { empty: "No live samples", error: "Live samples unavailable", hidden: "All selected series are hidden", loading: "Loading live samples" }, provenance: { dataRevision: paneSeries[0]?.dataRevision ?? null, decimation: "minmax_lttb", descriptorId: `live:${title.toLowerCase()}`, query: title, resourceKey: paneSeries[0]?.source.resourceKey ?? "data.table:default" } }}
        onExportRequested={onExport} onPointSelected={(seriesId, pointIndex) => { if (revision != null) onPointSelected(seriesId, pointIndex, revision); }} onRangeSelected={onRangeSelected} onRequestedExportHandled={onRequestedExportHandled}
      />}
    </ChartSection>;
  })}</div>;
}

function emptySeriesMessage(presentation: LiveChartsViewProps["presentation"]): string {
  switch (presentation.kind) {
    case "initial-loading": return "Loading live samples";
    case "error": return "Live samples unavailable";
    case "unsupported": return presentation.reason;
    case "empty": return "No live samples";
    default: return "Waiting for live samples";
  }
}

function presentationRevision(presentation: LiveChartsViewProps["presentation"]): string | number | null {
  switch (presentation.kind) {
    case "ready": return presentation.revision;
    case "refreshing":
    case "stale": return presentation.visibleRevision;
    case "paused": return presentation.visibleRevision;
    case "empty": return presentation.revision;
    default: return null;
  }
}
