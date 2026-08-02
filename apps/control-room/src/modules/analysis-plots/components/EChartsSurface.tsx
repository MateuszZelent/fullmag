"use client";

import { useEffect, useRef, useState } from "react";

import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  InteractiveChartSurface,
  chartSeriesRenderModel,
} from "@/shared/analysis-charts/InteractiveChartSurface";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

import {
  chartCursorPointFromEChartsClick,
  chartRangeFromDataZoomEvent,
  type ChartCursorPoint,
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
  allSeries?: readonly ChartSeries[];
  bus?: EventBus<KernelEventMap>;
  dataStatus?: string;
  fitRequest?: number;
  onPointSelect?: (point: ChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  presentation?: ChartDataPresentationState;
  series: readonly ChartSeries[];
  xAxisLabel?: string;
}

export function EChartsSurface({
  allSeries,
  bus,
  dataStatus,
  fitRequest,
  onPointSelect,
  onRangeChange,
  presentation,
  series,
  xAxisLabel,
}: EChartsSurfaceProps) {
  const [requestedExportFormat, setRequestedExportFormat] = useState<"csv" | "tsv" | "png" | null>(null);
  const rangeCommitTimerRef = useRef<number | null>(null);

  useEffect(() => () => cancelRangeCommit(rangeCommitTimerRef), [rangeCommitTimerRef]);
  useEffect(() => {
    if (!bus) return;
    const chartId = series[0]?.source.tableId ?? "default";
    return bus.on("analysis-plots:export-requested", (request) => {
      if (request.chartId === chartId) setRequestedExportFormat(request.format);
    });
  }, [bus, series]);

  return (
    <InteractiveChartSurface
      allSeries={allSeries}
      dataStatus={dataStatus}
      diagnostics={{
        instanceCreated: (chart) => {
          recordChartInstanceCreated();
          if (onRangeChange) recordChartDispatchDataZoom(chart as never);
        },
        instanceDisposed: recordChartInstanceDisposed,
        modelUpdated: (model) => {
          recordChartModelBuilt(model);
          recordChartDispatchPointClick((seriesIndex, dataIndex) => {
            const point = chartCursorPointFromEChartsClick({ dataIndex, seriesIndex }, series);
            if (point) onPointSelect?.(point);
          });
        },
        resized: recordChartResize,
        setOption: recordChartSetOption,
      }}
      fitRequest={fitRequest}
      presentation={presentation}
      requestedExportFormat={requestedExportFormat}
      series={series}
      xAxisLabel={xAxisLabel}
      onPointSelected={(seriesId, pointIndex) => {
        const point = chartCursorPointFromEChartsClick(
          { dataIndex: pointIndex, seriesIndex: series.findIndex((item) => item.id === seriesId) },
          series,
        );
        if (point) onPointSelect?.(point);
      }}
      onRangeSelected={(fromValue, toValue) => {
        const range = chartRangeFromDataZoomEvent({ endValue: toValue, startValue: fromValue });
        if (range) scheduleRangeCommit(rangeCommitTimerRef, () => onRangeChange?.(range));
      }}
      onRequestedExportHandled={() => setRequestedExportFormat(null)}
    />
  );
}

export { chartSeriesRenderModel as tableSeriesRenderModel };
