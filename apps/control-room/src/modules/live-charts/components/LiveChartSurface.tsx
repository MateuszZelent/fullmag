"use client";

import { Activity } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { exportChartData } from "@/shared/analysis-charts/ChartExportControls";
import { InteractiveChartSurface } from "@/shared/analysis-charts/InteractiveChartSurface";
import { liveChartExportModel, visibleLiveChartPanes } from "../liveChartsPresentation";
import { LiveChartSignals } from "./LiveChartSignals";
import type { LiveChartsViewProps } from "../liveChartsViewTypes";

export function LiveChartSurface({ fitRequest, onChartSelected, onPointSelected, onRangeSelected, onRequestedExportFailed, onRequestedExportHandled, onSeriesChange, presentation, requestedExportRequest, series, selectedSeriesIds, title, xAxisLabel }: Pick<LiveChartsViewProps, "fitRequest" | "onChartSelected" | "onExport" | "onPointSelected" | "onRangeSelected" | "onRequestedExportFailed" | "onRequestedExportHandled" | "onSeriesChange" | "presentation" | "requestedExportRequest" | "series" | "selectedSeriesIds" | "title" | "xAxisLabel">) {
  const selected = new Set(selectedSeriesIds);
  const panes = visibleLiveChartPanes(series, selectedSeriesIds);
  const exportRequest = requestedExportRequest ?? null;
  const completedPngPanes = useRef(new Set<string>());
  const pngRequestHandled = useRef<string | null>(null);
  const failedPngRequest = useRef<string | null>(null);
  const handledDataExport = useRef<string | null>(null);
  const activePngRequestId = exportRequest?.format === "png" ? exportRequest.requestId : null;
  const visibleSeries = useMemo(
    () => {
      const selectedIds = new Set(selectedSeriesIds);
      return series.filter((item) => selectedIds.has(item.id));
    },
    [selectedSeriesIds, series],
  );
  const dataExportModel = useMemo(
    () => liveChartExportModel(visibleSeries, title, xAxisLabel, presentation),
    [presentation, title, visibleSeries, xAxisLabel],
  );
  useEffect(() => {
    if (!exportRequest) {
      completedPngPanes.current.clear();
      pngRequestHandled.current = null;
      failedPngRequest.current = null;
      handledDataExport.current = null;
      return;
    }
    if (exportRequest.format === "png") {
      if (visibleSeries.length === 0) {
        if (pngRequestHandled.current !== exportRequest.requestId) {
          pngRequestHandled.current = exportRequest.requestId;
          onRequestedExportHandled();
        }
        return;
      }
      if (pngRequestHandled.current !== exportRequest.requestId && visibleSeries.every((item) => completedPngPanes.current.has(`${exportRequest.requestId}:${item.unit}`))) {
        pngRequestHandled.current = exportRequest.requestId;
        onRequestedExportHandled();
      }
      return;
    }
    if (handledDataExport.current === exportRequest.requestId) return;
    let exported = true;
    if (visibleSeries.some((item) => item.points.length > 0)) {
      exported = exportChartData(dataExportModel, exportRequest.format);
    }
    // An empty selection also acknowledges a command, so it cannot block the queue.
    handledDataExport.current = exportRequest.requestId;
    if (exported) onRequestedExportHandled();
    else acknowledgeExportFailure(onRequestedExportFailed, onRequestedExportHandled);
  }, [dataExportModel, exportRequest, onRequestedExportFailed, onRequestedExportHandled, visibleSeries]);
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
    return <ChartSection key={pane.unit} title={panelTitle} subtitle={`${pane.label} · ${visible.length} ${visible.length === 1 ? "signal" : "signals"}`} status={{ presentation, primary: "Live", pointSummary: sampleCount ? `${sampleCount.toLocaleString()} samples shown` : undefined }}>
      <InteractiveChartSurface
        allSeries={paneSeries} dataExportModel={dataExportModel} fitRequest={fitRequest} presentation={presentation} requestedExportRequest={exportRequest?.format === "png" ? exportRequest : null} series={visible} xAxisLabel={xAxisLabel}
        surface={{ ariaLabel: `${panelTitle} live chart`, chartId: `live-charts:${title}:${pane.unit}`, presentationCopy: { empty: "No live samples", error: "Live samples unavailable", hidden: "All selected series are hidden", loading: "Loading live samples" }, provenance: { dataRevision: paneSeries[0]?.dataRevision ?? null, decimation: "minmax_lttb", descriptorId: `live:${title.toLowerCase()}`, query: title, resourceKey: paneSeries[0]?.source.resourceKey ?? "data.table:default" } }}
        onPointSelected={(seriesId, pointIndex) => { if (revision != null) onPointSelected(seriesId, pointIndex, revision); }} onRangeSelected={onRangeSelected} onRequestedExportFailed={() => {
          if (activePngRequestId === null || failedPngRequest.current === activePngRequestId) return;
          failedPngRequest.current = activePngRequestId;
          acknowledgeExportFailure(onRequestedExportFailed, onRequestedExportHandled);
        }} onRequestedExportHandled={() => {
          if (activePngRequestId === null || failedPngRequest.current === activePngRequestId) return;
          completedPngPanes.current.add(`${activePngRequestId}:${pane.unit}`);
          if (pngRequestHandled.current !== activePngRequestId && panes.every((item) => completedPngPanes.current.has(`${activePngRequestId}:${item.unit}`))) {
            pngRequestHandled.current = activePngRequestId;
            onRequestedExportHandled();
          }
        }}
      />
    </ChartSection>;
  })}</div></div>;
}

function acknowledgeExportFailure(
  onRequestedExportFailed: (() => void) | undefined,
  onRequestedExportHandled: () => void,
): void {
  if (onRequestedExportFailed) {
    onRequestedExportFailed();
  } else {
    // Never leave a command waiting forever when a legacy caller has no
    // dedicated failure channel.
    onRequestedExportHandled();
  }
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
