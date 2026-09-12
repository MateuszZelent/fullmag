"use client";

import { Activity } from "lucide-react";
import { useEffect, useRef } from "react";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { exportChartData } from "@/shared/analysis-charts/ChartExportControls";
import { InteractiveChartSurface } from "@/shared/analysis-charts/InteractiveChartSurface";
import { liveChartExportModel, visibleLiveChartPanes } from "../liveChartsPresentation";
import { LiveChartSignals } from "./LiveChartSignals";
import type { LiveChartsViewProps } from "../liveChartsViewTypes";

export function LiveChartSurface({ fitRequest, onChartSelected, onPointSelected, onRangeSelected, onRequestedExportFailed, onRequestedExportHandled, onSeriesChange, presentation, requestedExportFormat, series, selectedSeriesIds, title, xAxisLabel }: Pick<LiveChartsViewProps, "fitRequest" | "onChartSelected" | "onExport" | "onPointSelected" | "onRangeSelected" | "onRequestedExportFailed" | "onRequestedExportHandled" | "onSeriesChange" | "presentation" | "requestedExportFormat" | "series" | "selectedSeriesIds" | "title" | "xAxisLabel">) {
  const selected = new Set(selectedSeriesIds);
  const panes = visibleLiveChartPanes(series, selectedSeriesIds);
  const completedPngPanes = useRef(new Set<string>());
  const pngRequestHandled = useRef<string | null>(null);
  const failedPngRequest = useRef<string | null>(null);
  const handledDataExport = useRef<"csv" | "tsv" | null>(null);
  const topologyKey = panes.map((pane) => `${pane.unit}:${pane.seriesIds.join(",")}`).join("|");
  const activePngRequestKey = requestedExportFormat === "png" ? topologyKey : null;
  useEffect(() => {
    if (!requestedExportFormat) {
      completedPngPanes.current.clear();
      pngRequestHandled.current = null;
      failedPngRequest.current = null;
      handledDataExport.current = null;
      return;
    }
    const selected = new Set(selectedSeriesIds);
    const visible = series.filter((item) => selected.has(item.id));
    if (requestedExportFormat === "png") {
      if (visible.length === 0) {
        if (pngRequestHandled.current !== activePngRequestKey) {
          pngRequestHandled.current = activePngRequestKey;
          onRequestedExportHandled();
        }
        return;
      }
      if (pngRequestHandled.current !== activePngRequestKey && visible.every((item) => completedPngPanes.current.has(`${activePngRequestKey}:${item.unit}`))) {
        pngRequestHandled.current = activePngRequestKey;
        onRequestedExportHandled();
      }
      return;
    }
    if (handledDataExport.current === requestedExportFormat) return;
    handledDataExport.current = requestedExportFormat;
    if (visible.some((item) => item.points.length > 0)) {
      exportChartData(liveChartExportModel(visible, title, xAxisLabel, presentation), requestedExportFormat);
    }
    // An empty selection also acknowledges a command, so it cannot block the queue.
    onRequestedExportHandled();
  }, [activePngRequestKey, onRequestedExportHandled, presentation, requestedExportFormat, selectedSeriesIds, series, title, xAxisLabel]);
  return <div className="fm-live-charts__workspace">
    <LiveChartSignals series={series} selectedSeriesIds={selectedSeriesIds} onSeriesChange={(ids) => { onChartSelected(); onSeriesChange(ids); }} />
    <div className="fm-live-charts__panes" data-pane-count={panes.length}>
    {panes.length === 0 ? <ChartSection title={title} status={{ presentation, primary: "Live" }}>
      <div className="fm-live-charts__empty" role="status">
        <Activity size={32} aria-hidden="true" />
        <strong>{series.length ? "Select at least one signal" : emptySeriesMessage(presentation)}</strong>
        <span>{series.length ? "Choose signals from the list to compare their evolution." : "Recorded scalar quantities will appear here as the simulation advances."}</span>
      </div>
    </ChartSection> : null}
    {panes.map((pane) => {
    const paneSeries = series.filter((item) => pane.seriesIds.includes(item.id));
    const visible = paneSeries.filter((item) => selected.has(item.id));
    const panelTitle = panes.length > 1 ? `${title} — ${pane.label}` : title;
    const revision = paneSeries.find((item) => item.dataRevision != null)?.dataRevision ?? presentationRevision(presentation);
    const sampleCount = visible.reduce((count, item) => Math.max(count, item.points.length), 0);
    return <ChartSection key={`${pane.unit}:${activePngRequestKey ?? "idle"}`} title={panelTitle} subtitle={`${pane.label} · ${visible.length} ${visible.length === 1 ? "signal" : "signals"}`} status={{ presentation, primary: "Live", pointSummary: sampleCount ? `${sampleCount.toLocaleString()} samples shown` : undefined }}>
      <InteractiveChartSurface
        allSeries={paneSeries} fitRequest={fitRequest} presentation={presentation} requestedExportFormat={requestedExportFormat === "png" ? "png" : null} series={visible} xAxisLabel={xAxisLabel}
        surface={{ ariaLabel: `${panelTitle} live chart`, chartId: `live-charts:${title}:${pane.unit}`, presentationCopy: { empty: "No live samples", error: "Live samples unavailable", hidden: "All selected series are hidden", loading: "Loading live samples" }, provenance: { dataRevision: paneSeries[0]?.dataRevision ?? null, decimation: "minmax_lttb", descriptorId: `live:${title.toLowerCase()}`, query: title, resourceKey: paneSeries[0]?.source.resourceKey ?? "data.table:default" } }}
        onPointSelected={(seriesId, pointIndex) => { if (revision != null) onPointSelected(seriesId, pointIndex, revision); }} onRangeSelected={onRangeSelected} onRequestedExportFailed={() => {
          if (activePngRequestKey === null || failedPngRequest.current === activePngRequestKey) return;
          failedPngRequest.current = activePngRequestKey;
          onRequestedExportFailed?.();
        }} onRequestedExportHandled={() => {
          if (activePngRequestKey === null || failedPngRequest.current === activePngRequestKey) return;
          completedPngPanes.current.add(`${activePngRequestKey}:${pane.unit}`);
          if (pngRequestHandled.current !== activePngRequestKey && panes.every((item) => completedPngPanes.current.has(`${activePngRequestKey}:${item.unit}`))) {
            pngRequestHandled.current = activePngRequestKey;
            onRequestedExportHandled();
          }
        }}
      />
    </ChartSection>;
  })}</div></div>;
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
