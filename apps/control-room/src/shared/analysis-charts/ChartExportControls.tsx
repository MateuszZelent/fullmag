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

export function exportChartData(model: ChartRenderModel, format: ChartExportFormat): void {
  downloadChartBlob({
    content: serializeChartData(model, format),
    filename: safeChartExportFilename(model, format),
    mimeType: format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8",
  });
  downloadChartBlob({
    content: JSON.stringify(chartExportProvenance(model), null, 2),
    filename: safeChartExportFilename(model, `.provenance.json`),
    mimeType: "application/json",
  });
}

export function exportChartPng(
  model: ChartRenderModel,
  rendererRef: MutableRefObject<ChartRendererOwner | null>,
): boolean {
  const dataUrl = rendererRef.current?.exportPng();
  if (!dataUrl) return false;
  const anchor = document.createElement("a");
  anchor.download = safeChartExportFilename(model, "png");
  anchor.href = dataUrl;
  anchor.click();
  downloadChartBlob({
    content: JSON.stringify(chartExportProvenance(model), null, 2),
    filename: safeChartExportFilename(model, "provenance.json"),
    mimeType: "application/json",
  });
  return true;
}

export function ChartExportControls({
  model,
  pngReady = true,
  rendererRef,
  onExportRequested,
  onOpenPointsTable,
}: {
  model: ChartRenderModel;
  /** Optional readiness gate for callers whose renderer initializes asynchronously. */
  pngReady?: boolean;
  onExportRequested?: (format: ChartExportFormat | "png") => void;
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
      <Button size="sm" type="button" variant="secondary" onClick={() => { onExportRequested?.("csv"); exportChartData(model, "csv"); }}>CSV</Button>
      <Button size="sm" type="button" variant="secondary" onClick={() => { onExportRequested?.("tsv"); exportChartData(model, "tsv"); }}>TSV</Button>
      <Button disabled={!pngReady} size="sm" type="button" variant="secondary" onClick={() => { onExportRequested?.("png"); exportChartPng(model, rendererRef); }}>PNG</Button>
    </div>
  );
}
