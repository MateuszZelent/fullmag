"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { EChartsCanvasSurface } from "@/shared/analysis-charts/EChartsCanvasSurface";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import { PointsTableDialog } from "@/shared/analysis-charts/PointsTableDialog";
import {
  ChartExportControls,
  exportChartData,
  exportChartPng,
} from "@/shared/analysis-charts/ChartExportControls";
import type { ChartRendererOwner, ChartRenderModel } from "@/shared/analysis-charts/chartRenderer";
import {
  chartCursorPointFromEChartsClick,
  chartRangeFromDataZoomEvent,
  type ChartCursorPoint,
  type ChartSeries,
  type ChartValueRange,
} from "../chartTableModel";
import {
  recordChartDispatchDataZoom,
  recordChartDispatchPointClick,
  recordChartInstanceCreated,
  recordChartInstanceDisposed,
  recordChartModelBuilt,
  recordChartResize,
  recordChartSetOption,
} from "./chartDiagnostics";
import { cancelRangeCommit, scheduleRangeCommit } from "./chartRangeCommit";

interface EChartsSurfaceProps {
  bus?: EventBus<KernelEventMap>;
  dataStatus?: string;
  fitRequest?: number;
  onPointSelect?: (point: ChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  /** Visible series — rendered in the chart */
  series: readonly ChartSeries[];
  presentation?: ChartDataPresentationState;
  /** All series in this resource family — used for stable axis labels regardless of visibility */
  allSeries?: readonly ChartSeries[];
  xAxisLabel?: string;
}

export function EChartsSurface({
  bus,
  dataStatus,
  fitRequest = 0,
  onPointSelect,
  onRangeChange,
  presentation: providedPresentation,
  series,
  allSeries,
  xAxisLabel,
}: EChartsSurfaceProps) {
  const [isTableOpen, setIsTableOpen] = useState(false);
  const exportRef = useRef<ChartRendererOwner | null>(null);
  const rangeCommitTimerRef = useRef<number | null>(null);
  const model = useMemo(
    () => tableSeriesRenderModel(series, allSeries ?? series, xAxisLabel, dataStatus, providedPresentation),
    [dataStatus, providedPresentation, series, allSeries, xAxisLabel],
  );

  useEffect(() => () => cancelRangeCommit(rangeCommitTimerRef), []);
  useEffect(() => {
    if (fitRequest > 0) exportRef.current?.fitView();
  }, [fitRequest]);
  useEffect(() => {
    if (!bus) return;
    const chartId = series[0]?.source.tableId ?? "default";
    return bus.on("analysis-plots:export-requested", (request) => {
      if (request.chartId !== chartId) return;
      if (request.format === "png") {
        exportChartPng(model, exportRef);
      } else {
        exportChartData(model, request.format);
      }
    });
  }, [bus, model, series]);

  return (
    <div className="fm-analysis-plots__chart-frame">
      <EChartsCanvasSurface
        diagnostics={{
          instanceCreated: (chart) => {
            recordChartInstanceCreated();
            if (onRangeChange) recordChartDispatchDataZoom(chart as never);
          },
          instanceDisposed: recordChartInstanceDisposed,
          modelUpdated: (nextModel) => {
            recordChartModelBuilt(nextModel);
            recordChartDispatchPointClick((seriesIndex, dataIndex) => {
              const point = chartCursorPointFromEChartsClick(
                { dataIndex, seriesIndex },
                series,
              );
              if (point) onPointSelect?.(point);
            });
          },
          resized: recordChartResize,
          setOption: recordChartSetOption,
        }}
        exportRef={exportRef}
        model={model}
        presentation={providedPresentation}
        onClick={(event) => {
          const point = chartCursorPointFromEChartsClick(event, series);
          if (point) onPointSelect?.(point);
        }}
        onDataZoom={(event) => {
          const range = chartRangeFromDataZoomEvent(event);
          if (!range) return;
          scheduleRangeCommit(rangeCommitTimerRef, () => onRangeChange?.(range));
        }}
      />
      <ChartExportControls
        model={model}
        rendererRef={exportRef}
        onOpenPointsTable={() => setIsTableOpen(true)}
      />
      <PointsTableDialog
        model={model}
        open={isTableOpen}
        onClose={() => setIsTableOpen(false)}
      />
    </div>
  );
}

export function tableSeriesRenderModel(
  series: readonly ChartSeries[],
  allSeries: readonly ChartSeries[],
  xAxisLabel?: string,
  dataStatus?: string,
  presentation?: ChartDataPresentationState,
): ChartRenderModel {
  // Use allSeries for unit grouping so axis slots are stable when series are hidden
  const units = [...new Set(allSeries.map((item) => item.unit))].slice(0, 2);
  const allSeriesHaveSamples = allSeries.some((item) => item.points.length > 0);
  // X-axis unit comes from the series metadata (xUnit field)
  const xUnit = series.find((s) => s.xUnit)?.xUnit ?? allSeries.find((s) => s.xUnit)?.xUnit ?? "";
  const status = renderStatusForPresentation(
    presentation,
    dataStatus,
    series.some((item) => item.points.length > 0),
  );
  return {
    ariaLabel: "Analysis chart",
    key: JSON.stringify([
      xAxisLabel ?? "x",
      presentation?.kind ?? dataStatus ?? "ready",
      ...series.map((item) => [
        item.id,
        item.points.length,
        item.points.at(-1)?.rowIndex,
      ]),
    ]),
    provenance: {
      dataRevision: series[0]?.dataRevision ?? null,
      decimation: "minmax_lttb",
      descriptorId: `analysis:data-table:${series[0]?.source.tableId ?? "default"}`,
      query: JSON.stringify({ xAxisLabel, series: series.map((item) => item.id) }),
      resourceKey: series[0]?.source.resourceKey ?? "data.table:default",
    },
    series: series.map((item) => ({
      id: item.id,
      kind: "line",
      label: item.label || item.quantity,
      points: item.points,
      unit: item.unit,
      yAxis: Math.max(0, units.indexOf(item.unit)),
    })),
    status,
    statusMessage:
      presentationMessage(presentation, status, allSeriesHaveSamples, dataStatus),
    // Keep semantic label and canonical unit separate. The renderer applies the
    // same auto-scale to ticks, tooltip and axis name (e.g. t [ns]).
    xAxis: { label: xAxisLabel ?? "x", unit: xUnit },
    yAxes: (units.length > 0 ? units : [""]).map((unit) => ({
      // Derive axis label from ALL series in family (not just visible)
      // so the axis name stays stable when series are hidden/shown.
      label: quantityLabelForUnit(unit, allSeries),
      unit,
    })),
  };
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
): string | undefined {
  switch (presentation?.kind) {
    case "initial-loading": return "Loading table samples";
    case "refreshing": return "Updating";
    case "stale": return `Refresh failed: ${presentation.error.message}`;
    case "paused": return "Paused";
    case "unsupported": return presentation.reason;
    case "error": return presentation.error.message;
    default:
      return status === "empty"
        ? allSeriesHaveSamples
          ? "All selected series are hidden"
          : "No table samples"
        : status === "error"
          ? "Table samples unavailable"
          : dataStatus === "loading" || dataStatus === "stale"
            ? "Loading table samples"
            : undefined;
  }
}

/**
 * Derive a human-readable dimension label for a Y axis from the unit and the series
 * it contains. Falls back to the unit itself if no better label is available.
 */
function quantityLabelForUnit(unit: string, series: readonly ChartSeries[]): string {
  // Find the first series with this unit and use its label as the axis name
  const match = series.find((s) => s.unit === unit);
  if (!match) return "Value";
  const sameUnit = series.filter((s) => s.unit === unit);
  const labels = sameUnit.map((entry) => entry.quantity.toLowerCase());
  if (unit === "1" && labels.every((label) => ["mx", "my", "mz", "m"].includes(label))) {
    return "Normalized magnetization m";
  }
  if (sameUnit.length === 1) return match.label || match.quantity;
  if (labels.every((label) => label.includes("torque"))) return "Torque";
  if (labels.every((label) => label.includes("residual"))) return "Residual";
  // For mixed quantities, retain a visible semantic caption instead of
  // forcing the user to infer meaning from a unit alone.
  return "Value";
}
