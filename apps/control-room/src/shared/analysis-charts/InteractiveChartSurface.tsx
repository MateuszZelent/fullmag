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

export interface ChartInteractionCallbacks {
  onExportRequested?: (format: "csv" | "tsv" | "png") => void;
  onPointSelected?: (seriesId: string, pointIndex: number) => void;
  onRangeSelected?: (fromSI: number, toSI: number) => void;
  onRequestedExportFailed?: () => void;
}

export interface InteractiveChartSurfaceIdentity {
  ariaLabel: string;
  chartId: string;
  presentationCopy: {
    empty: string;
    error: string;
    hidden?: string;
    loading: string;
  };
  provenance: NonNullable<ChartRenderModel["provenance"]>;
}

export interface InteractiveChartSurfaceProps extends ChartInteractionCallbacks {
  allSeries?: readonly ChartSeries[];
  /** Optional model used by CSV/TSV controls when the visible pane is only a view. */
  dataExportModel?: ChartRenderModel;
  dataStatus?: string;
  diagnostics?: {
    instanceCreated?: (instance: ChartRendererInstance) => void;
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

export function chartSeriesRenderModel(
  series: readonly ChartSeries[],
  allSeries: readonly ChartSeries[],
  surface: InteractiveChartSurfaceIdentity,
  xAxisLabel?: string,
  dataStatus?: string,
  presentation?: ChartDataPresentationState,
): ChartRenderModel {
  const units = [...new Set(allSeries.map((item) => item.unit))].slice(0, 2);
  const allSeriesHaveSamples = allSeries.some((item) => item.points.length > 0);
  const xUnit = series.find((item) => item.xUnit)?.xUnit ?? allSeries.find((item) => item.xUnit)?.xUnit ?? "";
  const colorIndexBySeriesId = new Map<string, number>();
  allSeries.forEach((item, index) => {
    if (!colorIndexBySeriesId.has(item.id)) colorIndexBySeriesId.set(item.id, index);
  });
  const status = renderStatusForPresentation(
    presentation,
    dataStatus,
    series.some((item) => item.points.length > 0),
  );
  return {
    ariaLabel: surface.ariaLabel,
    key: surface.chartId,
    provenance: surface.provenance,
    series: series.map((item, visibleIndex) => {
      return {
        colorIndex: colorIndexBySeriesId.get(item.id) ?? visibleIndex,
        id: item.id,
        kind: "line" as const,
        label: item.label || item.quantity,
        points: item.points,
        unit: item.unit,
        yAxis: Math.max(0, units.indexOf(item.unit)),
      };
    }),
    status,
    statusMessage: presentationMessage(
      presentation,
      status,
      allSeriesHaveSamples,
      dataStatus,
      surface.presentationCopy,
    ),
    xAxis: { label: xAxisLabel ?? "x", unit: xUnit },
    yAxes: (units.length > 0 ? units : [""]).map((unit) => ({
      label: quantityLabelForUnit(unit, allSeries),
      unit,
    })),
  };
}

function chartPointFromEChartsClick(
  event: unknown,
  chartSeries: readonly ChartSeries[],
): { pointIndex: number; seriesId: string } | null {
  const record = event && typeof event === "object" ? event : null;
  if (!record) return null;
  const seriesIndex = "seriesIndex" in record ? Number(record.seriesIndex) : NaN;
  const pointIndex = "dataIndex" in record ? Number(record.dataIndex) : NaN;
  if (!Number.isInteger(seriesIndex) || !Number.isInteger(pointIndex) || seriesIndex < 0 || pointIndex < 0) return null;
  const series = chartSeries[seriesIndex];
  return series?.points[pointIndex]
    ? { pointIndex, seriesId: series.id }
    : null;
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

function renderStatusForPresentation(
  presentation: ChartDataPresentationState | undefined,
  dataStatus: string | undefined,
  hasPoints: boolean,
): ChartRenderModel["status"] {
  switch (presentation?.kind) {
    case "initial-loading": return "loading";
    case "empty": return "empty";
    case "unsupported": return "unsupported";
    case "error": return "error";
    default:
      return dataStatus === "error"
        ? "error"
        : dataStatus === "loading"
          ? "loading"
          : dataStatus === "stale"
            ? "stale"
            : hasPoints
              ? "ready"
              : "empty";
  }
}

function presentationMessage(
  presentation: ChartDataPresentationState | undefined,
  status: ChartRenderModel["status"],
  allSeriesHaveSamples: boolean,
  dataStatus: string | undefined,
  copy: InteractiveChartSurfaceIdentity["presentationCopy"],
): string | undefined {
  switch (presentation?.kind) {
    case "initial-loading": return copy.loading;
    case "refreshing": return "Updating";
    case "stale": return `Refresh failed: ${presentation.error.message}`;
    case "paused": return "Paused";
    case "unsupported": return presentation.reason;
    case "error": return presentation.error.message;
    default:
      return status === "empty"
        ? allSeriesHaveSamples
          ? copy.hidden ?? copy.empty
          : copy.empty
        : status === "error"
          ? copy.error
          : dataStatus === "loading" || dataStatus === "stale"
            ? copy.loading
            : undefined;
  }
}

function quantityLabelForUnit(unit: string, series: readonly ChartSeries[]): string {
  const match = series.find((entry) => entry.unit === unit);
  if (!match) return "Value";
  const sameUnit = series.filter((entry) => entry.unit === unit);
  const labels = sameUnit.map((entry) => entry.quantity.toLowerCase());
  if (unit === "1" && labels.every((label) => ["mx", "my", "mz", "m"].includes(label))) return "Normalized magnetization m";
  if (sameUnit.length === 1) return match.label || match.quantity;
  if (labels.every((label) => label.includes("torque"))) return "Torque";
  if (labels.every((label) => label.includes("residual"))) return "Residual";
  return "Value";
}
