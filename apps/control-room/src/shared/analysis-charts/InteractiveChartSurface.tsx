"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChartDataPresentationState } from "./chartPresentationState";
import { ChartExportControls } from "./ChartExportControls";
import { exportChartData, exportChartPng } from "./chartExport";
import type { ChartExportRequest } from "./chartExport";
import { EChartsCanvasSurface } from "./EChartsCanvasSurface";
import { PointsTableDialog } from "./PointsTableDialog";
import type { ChartRendererInstance, ChartRendererOwner, ChartRenderModel } from "./chartRenderer";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import {
  chartPointFromEChartsClick,
  chartSeriesRenderModel,
  type InteractiveChartSurfaceIdentity,
} from "./interactiveChartModel";

export interface ChartInteractionCallbacks {
  onExportRequested?: (format: "csv" | "tsv" | "png") => void;
  onPointSelected?: (seriesId: string, pointIndex: number) => void;
  onRangeSelected?: (fromSI: number, toSI: number) => void;
  onRequestedExportFailed?: () => void;
}

export interface InteractiveChartSurfaceProps extends ChartInteractionCallbacks {
  allSeries?: readonly ChartSeries[];
  /** Optional model used by CSV/TSV controls when the visible pane is only a view. */
  dataExportModel?: ChartRenderModel;
  dataStatus?: string;
  diagnostics?: {
    instanceCreated?: (instance: ChartRendererInstance) => void | (() => void);
    instanceDisposed?: () => void;
    modelUpdated?: (model: ChartRenderModel) => void;
    resized?: () => void;
    setOption?: () => void;
  };
  fitRequest?: number;
  initialRange?: { fromValue: number; toValue: number } | null;
  presentation?: ChartDataPresentationState;
  requestedExportRequest?: ChartExportRequest | null;
  series: readonly ChartSeries[];
  surface: InteractiveChartSurfaceIdentity;
  ownerStatus?: string;
  xAxisLabel?: string;
  onRequestedExportHandled?: () => void;
}

export function InteractiveChartSurface({
  allSeries,
  dataStatus,
  dataExportModel,
  diagnostics,
  fitRequest = 0,
  initialRange = null,
  onExportRequested,
  onPointSelected,
  onRangeSelected,
  onRequestedExportHandled,
  onRequestedExportFailed,
  presentation,
  requestedExportRequest,
  series,
  surface,
  ownerStatus,
  xAxisLabel,
}: InteractiveChartSurfaceProps) {
  const [isTableOpen, setIsTableOpen] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const exportRef = useRef<ChartRendererOwner | null>(null);
  const rendererErrorRef = useRef(false);
  const handledExportRequestRef = useRef<string | null>(null);
  const exportRequest = requestedExportRequest ?? null;
  const model = useMemo(
    () => chartSeriesRenderModel(series, allSeries ?? series, surface, xAxisLabel, dataStatus, presentation),
    [allSeries, dataStatus, presentation, series, surface, xAxisLabel],
  );

  useEffect(() => {
    if (fitRequest > 0) exportRef.current?.fitView();
  }, [fitRequest, rendererReady]);
  useEffect(() => {
    if (!exportRequest) {
      handledExportRequestRef.current = null;
      return;
    }
    if (handledExportRequestRef.current === exportRequest.requestId) return;
    if (exportRequest.format === "png" && rendererErrorRef.current) {
      handledExportRequestRef.current = exportRequest.requestId;
      acknowledgeExportFailure(onRequestedExportFailed, onRequestedExportHandled);
      return;
    }
    if (exportRequest.format === "png" && !rendererReady) return;
    let exported = false;
    try {
      onExportRequested?.(exportRequest.format);
      if (exportRequest.format === "png") {
        exported = exportChartPng(model, exportRef);
      } else {
        exported = exportChartData(dataExportModel ?? model, exportRequest.format);
      }
    } catch {
      exported = false;
    }
    handledExportRequestRef.current = exportRequest.requestId;
    if (!exported) {
      acknowledgeExportFailure(onRequestedExportFailed, onRequestedExportHandled);
      return;
    }
    onRequestedExportHandled?.();
  }, [dataExportModel, exportRequest, model, onExportRequested, onRequestedExportFailed, onRequestedExportHandled, rendererReady]);

  return (
    <div className="fm-analysis-plots__chart-frame">
      <EChartsCanvasSurface
        diagnostics={diagnostics}
        exportRef={exportRef}
        initialRange={initialRange}
        model={model}
        onRendererReady={() => {
          rendererErrorRef.current = false;
          setRendererReady(true);
        }}
        onRendererError={() => {
          rendererErrorRef.current = true;
          if (exportRequest?.format === "png" && handledExportRequestRef.current !== exportRequest.requestId) {
            handledExportRequestRef.current = exportRequest.requestId;
            acknowledgeExportFailure(onRequestedExportFailed, onRequestedExportHandled);
          }
        }}
        presentation={presentation}
        ownerStatus={ownerStatus}
        onClick={(event) => {
          const point = chartPointFromEChartsClick(event, series);
          if (point) onPointSelected?.(point.seriesId, point.pointIndex);
        }}
        onDataZoom={(event) => {
          const range = chartRangeFromDataZoomEvent(event);
          if (range) onRangeSelected?.(range.fromValue, range.toValue);
        }}
      />
      <ChartExportControls
        model={model}
        dataModel={dataExportModel}
        pngReady={rendererReady}
        rendererRef={exportRef}
        onExportRequested={onExportRequested}
        onOpenPointsTable={() => setIsTableOpen(true)}
      />
      <PointsTableDialog
        model={model}
        open={isTableOpen}
        onClose={() => setIsTableOpen(false)}
        onPointSelected={onPointSelected}
      />
    </div>
  );
}

function acknowledgeExportFailure(
  onRequestedExportFailed: (() => void) | undefined,
  onRequestedExportHandled: (() => void) | undefined,
): void {
  if (onRequestedExportFailed) {
    onRequestedExportFailed();
  } else {
    // A request must always reach a terminal acknowledgement. Callers that do
    // not expose a failure channel still need to release their command queue.
    onRequestedExportHandled?.();
  }
}

function chartRangeFromDataZoomEvent(event: unknown): { fromValue: number; toValue: number } | null {
  const record = event && typeof event === "object" ? event : null;
  if (!record) return null;
  const batch = "batch" in record ? record.batch : null;
  const entry = Array.isArray(batch) && batch.length > 0 ? batch[0] : record;
  if (!entry || typeof entry !== "object") return null;
  const startValue = "startValue" in entry ? Number(entry.startValue) : NaN;
  const endValue = "endValue" in entry ? Number(entry.endValue) : NaN;
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  return { fromValue: Math.min(startValue, endValue), toValue: Math.max(startValue, endValue) };
}
