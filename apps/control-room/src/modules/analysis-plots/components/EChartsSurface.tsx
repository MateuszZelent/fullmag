"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  InteractiveChartSurface,
  chartSeriesRenderModel,
} from "@/shared/analysis-charts/InteractiveChartSurface";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import type { InteractiveChartSurfaceIdentity } from "@/shared/analysis-charts/InteractiveChartSurface";
import type {
  ChartResultExportContext,
} from "@/shared/analysis-charts/chartRenderer";
import type { ChartExportRequest } from "@/shared/analysis-charts/chartExport";

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
  chartId?: string;
  dataStatus?: string;
  descriptorId?: string;
  displayUnits?: Readonly<Record<string, string>>;
  exportProvenance?: ChartResultExportContext;
  fitRequest?: number;
  initialRange?: ChartValueRange | null;
  onPointSelect?: (point: ChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  presentation?: ChartDataPresentationState;
  series: readonly ChartSeries[];
  xAxisLabel?: string;
}

export function EChartsSurface(props: EChartsSurfaceProps) {
  const stableChartKey = props.chartId ?? "default";
  return <EChartsSurfaceImpl key={stableChartKey} {...props} />;
}

function EChartsSurfaceImpl({
  allSeries,
  bus,
  chartId,
  dataStatus,
  descriptorId,
  displayUnits,
  exportProvenance,
  fitRequest,
  initialRange,
  onPointSelect,
  onRangeChange,
  presentation,
  series,
  xAxisLabel,
}: EChartsSurfaceProps) {
  const [requestedExportRequest, setRequestedExportRequest] = useState<ChartExportRequest | null>(null);
  const exportRequestSequenceRef = useRef(0);
  const queuedExportRequestsRef = useRef<ChartExportRequest[]>([]);
  const activeExportRequestRef = useRef<ChartExportRequest | null>(null);
  const rangeCommitTimerRef = useRef<number | null>(null);
  const acceptedChartId = chartId ?? series[0]?.source.tableId ?? "default";
  const enqueueExportRequest = useCallback((request: ChartExportRequest) => {
    if (
      activeExportRequestRef.current?.requestId === request.requestId ||
      queuedExportRequestsRef.current.some((queued) => queued.requestId === request.requestId)
    ) return;
    if (activeExportRequestRef.current) {
      queuedExportRequestsRef.current.push(request);
      return;
    }
    activeExportRequestRef.current = request;
    setRequestedExportRequest(request);
  }, []);
  const acknowledgeExportRequest = useCallback((requestId: string | null) => {
    if (!requestId || activeExportRequestRef.current?.requestId !== requestId) return;
    const next = queuedExportRequestsRef.current.shift() ?? null;
    activeExportRequestRef.current = next;
    setRequestedExportRequest(next);
  }, []);
  const surfaceStatus = presentation?.kind === "refreshing" && series.some((entry) => entry.points.length > 0)
    ? "refreshing"
    : undefined;
  const surface = useMemo(
    () => analysisChartSurfaceIdentity(series, xAxisLabel, dataStatus, presentation, chartId, displayUnits, descriptorId, exportProvenance),
    [chartId, dataStatus, descriptorId, displayUnits, exportProvenance, presentation, series, xAxisLabel],
  );

  useEffect(() => () => cancelRangeCommit(rangeCommitTimerRef), [rangeCommitTimerRef]);
  useEffect(() => {
    if (!bus) return;
    return bus.subscribe("analysis-plots:export-requested", (request) => {
      if (request.chartId === acceptedChartId) {
        enqueueExportRequest({
          format: request.format,
          requestId: request.requestId ?? `analysis-chart-export-${acceptedChartId}-${++exportRequestSequenceRef.current}`,
        });
      }
    });
  }, [acceptedChartId, bus, enqueueExportRequest]);

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
      initialRange={initialRange}
      presentation={presentation}
      requestedExportRequest={requestedExportRequest}
      series={series}
      surface={surface}
      ownerStatus={surfaceStatus}
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
      onRequestedExportHandled={() => acknowledgeExportRequest(requestedExportRequest?.requestId ?? null)}
      onRequestedExportFailed={() => acknowledgeExportRequest(requestedExportRequest?.requestId ?? null)}
    />
  );
}

function analysisChartSurfaceIdentity(
  series: readonly ChartSeries[],
  xAxisLabel: string | undefined,
  dataStatus: string | undefined,
  presentation: ChartDataPresentationState | undefined,
  chartId?: string,
  displayUnits?: Readonly<Record<string, string>>,
  descriptorId?: string,
  exportProvenance?: ChartResultExportContext,
): InteractiveChartSurfaceIdentity {
  return {
    ariaLabel: "Analysis chart",
    chartId: chartId ?? JSON.stringify([
      xAxisLabel ?? "x",
      presentation?.kind ?? dataStatus ?? "ready",
      ...series.map((item) => [item.id, item.points.length, item.points.at(-1)?.rowIndex]),
    ]),
    presentationCopy: {
      empty: "No table samples",
      error: "Table samples unavailable",
      hidden: "All selected series are hidden",
      loading: "Loading table samples",
    },
    provenance: {
      ...series[0]?.sourceIdentity,
      ...exportProvenance,
      dataRevision: series[0]?.dataRevision ?? null,
      decimation: "minmax_lttb",
      descriptorId: descriptorId ?? `analysis:data-table:${series[0]?.source.tableId ?? "default"}`,
      displayUnits: Object.fromEntries(series.flatMap((item) => {
        const unit = displayUnits?.[item.quantity];
        return unit ? [[`y:${item.id}`, unit]] : [];
      })),
      query: JSON.stringify({ xAxisLabel, series: series.map((item) => item.id) }),
      resourceKey: series[0]?.source.resourceKey ?? "data.table:default",
    },
  };
}

export function tableSeriesRenderModel(
  series: readonly ChartSeries[],
  allSeries: readonly ChartSeries[],
  xAxisLabel?: string,
  dataStatus?: string,
  presentation?: ChartDataPresentationState,
) {
  return chartSeriesRenderModel(
    series,
    allSeries,
    analysisChartSurfaceIdentity(series, xAxisLabel, dataStatus, presentation),
    xAxisLabel,
    dataStatus,
    presentation,
  );
}
