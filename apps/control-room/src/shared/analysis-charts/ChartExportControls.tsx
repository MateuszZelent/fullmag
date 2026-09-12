"use client";

import type { MutableRefObject } from "react";

import { Button } from "@/shared/ui/Button";

import {
  chartExportProvenance,
  downloadChartBlob,
  safeChartExportFilename,
  serializeChartData,
  type ChartExportFormat,
} from "./chartExport";
import type { ChartRendererOwner, ChartRenderModel } from "./chartRenderer";

export function exportChartData(model: ChartRenderModel, format: ChartExportFormat): boolean {
  try {
    const dataDownloaded = downloadChartBlob({
      content: serializeChartData(model, format),
      filename: safeChartExportFilename(model, format),
      mimeType: format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8",
    });
    if (!dataDownloaded) return false;
    return downloadChartBlob({
      content: JSON.stringify(chartExportProvenance(model), null, 2),
      filename: safeChartExportFilename(model, `.provenance.json`),
      mimeType: "application/json",
    });
  } catch {
    return false;
  }
}

export function exportChartPng(
  model: ChartRenderModel,
  rendererRef: MutableRefObject<ChartRendererOwner | null>,
): boolean {
  try {
    const dataUrl = rendererRef.current?.exportPng();
    if (!dataUrl) return false;
    const anchor = document.createElement("a");
    anchor.download = safeChartExportFilename(model, "png");
    anchor.href = dataUrl;
    anchor.click();
    return downloadChartBlob({
      content: JSON.stringify(chartExportProvenance(model), null, 2),
      filename: safeChartExportFilename(model, "provenance.json"),
      mimeType: "application/json",
    });
  } catch {
    return false;
  }
}

export function ChartExportControls({
  model,
  dataModel,
  pngReady = true,
  rendererRef,
  onExportRequested,
  onExportFailed,
  onOpenPointsTable,
}: {
  model: ChartRenderModel;
  /** Optional model for data exports that intentionally span multiple panes. */
  dataModel?: ChartRenderModel;
  /** Optional readiness gate for callers whose renderer initializes asynchronously. */
  pngReady?: boolean;
  onExportRequested?: (format: ChartExportFormat | "png") => void;
  onExportFailed?: (format: ChartExportFormat | "png") => void;
  rendererRef: MutableRefObject<ChartRendererOwner | null>;
  onOpenPointsTable?: () => void;
}) {
  return (
    <div className="fm-analysis-chart-export" aria-label="Chart export">
      {onOpenPointsTable ? (
        <Button size="sm" type="button" variant="secondary" onClick={onOpenPointsTable}>
          Data Table
        </Button>
      ) : null}
      <Button size="sm" type="button" variant="secondary" onClick={() => {
        onExportRequested?.("csv");
        if (!exportChartData(dataModel ?? model, "csv")) onExportFailed?.("csv");
      }}>CSV</Button>
      <Button size="sm" type="button" variant="secondary" onClick={() => {
        onExportRequested?.("tsv");
        if (!exportChartData(dataModel ?? model, "tsv")) onExportFailed?.("tsv");
      }}>TSV</Button>
      <Button disabled={!pngReady} size="sm" type="button" variant="secondary" onClick={() => {
        onExportRequested?.("png");
        if (!exportChartPng(model, rendererRef)) onExportFailed?.("png");
      }}>PNG</Button>
    </div>
  );
}
