"use client";

import { useEffect, useMemo, useRef } from "react";

import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { EChartsCanvasSurface } from "@/shared/analysis-charts/EChartsCanvasSurface";
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
  onPointSelect?: (point: ChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  series: readonly ChartSeries[];
  xAxisLabel?: string;
}

export function EChartsSurface({
  bus,
  dataStatus,
  onPointSelect,
  onRangeChange,
  series,
  xAxisLabel,
}: EChartsSurfaceProps) {
  const exportRef = useRef<ChartRendererOwner | null>(null);
  const rangeCommitTimerRef = useRef<number | null>(null);
  const model = useMemo(
    () => tableSeriesRenderModel(series, xAxisLabel, dataStatus),
    [dataStatus, series, xAxisLabel],
  );

  useEffect(() => () => cancelRangeCommit(rangeCommitTimerRef), []);
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
      <ChartExportControls model={model} rendererRef={exportRef} />
    </div>
  );
}

export function tableSeriesRenderModel(
  series: readonly ChartSeries[],
  xAxisLabel?: string,
  dataStatus?: string,
): ChartRenderModel {
  const units = [...new Set(series.map((item) => item.unit))].slice(0, 2);
  const status =
    dataStatus === "error"
      ? "error"
      : dataStatus === "loading"
        ? "loading"
        : dataStatus === "stale"
          ? "stale"
          : series.some((item) => item.points.length > 0)
            ? "ready"
            : "empty";
  return {
    ariaLabel: "Analysis chart",
    key: JSON.stringify([
      xAxisLabel ?? "x",
      dataStatus ?? "ready",
      ...series.map((item) => [
        item.id,
        item.points.length,
        item.points.at(-1)?.rowIndex,
      ]),
    ]),
    provenance: {
      dataRevision: series[0]?.dataRevision ?? null,
      decimation: "minmax_lttb",
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
      status === "error"
        ? "Table samples unavailable"
        : status === "loading" || status === "stale"
          ? "Loading table samples"
          : status === "empty"
            ? "No table samples"
            : undefined,
    xAxis: { label: xAxisLabel ?? "x", unit: "" },
    yAxes: (units.length > 0 ? units : [""]).map((unit) => ({
      label: unit ? `[${unit}]` : "",
      unit,
    })),
  };
}
