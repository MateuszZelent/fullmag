"use client";

import { useState, type MutableRefObject } from "react";

import { Button } from "@/shared/ui/Button";

import {
  exportChartData,
  exportChartPng,
  type ChartExportFormat,
} from "./chartExport";
import type { ChartRendererOwner, ChartRenderModel } from "./chartRenderer";

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
  const [failedExportFormat, setFailedExportFormat] = useState<ChartExportFormat | "png" | null>(null);

  const runExport = (format: ChartExportFormat | "png", exportAction: () => boolean) => {
    setFailedExportFormat(null);
    let exported = false;
    try {
      onExportRequested?.(format);
      exported = exportAction();
    } catch {
      exported = false;
    }
    if (exported) return;
    setFailedExportFormat(format);
    try {
      onExportFailed?.(format);
    } catch {
      // Keep the local accessible error even if an optional callback fails.
    }
  };

  return (
    <div className="fm-analysis-chart-export" aria-label="Chart export">
      {onOpenPointsTable ? (
        <Button size="sm" type="button" variant="secondary" onClick={onOpenPointsTable}>
          Data Table
        </Button>
      ) : null}
      <Button size="sm" type="button" variant="secondary" onClick={() => runExport("csv", () => exportChartData(dataModel ?? model, "csv"))}>CSV</Button>
      <Button size="sm" type="button" variant="secondary" onClick={() => runExport("tsv", () => exportChartData(dataModel ?? model, "tsv"))}>TSV</Button>
      <Button disabled={!pngReady} size="sm" type="button" variant="secondary" onClick={() => runExport("png", () => exportChartPng(model, rendererRef))}>PNG</Button>
      {failedExportFormat ? <p className="fm-analysis-chart-export__error" role="alert">
        {failedExportFormat.toUpperCase()} export failed. Try again.
      </p> : null}
    </div>
  );
}
