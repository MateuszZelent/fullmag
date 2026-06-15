"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { ECharts } from "echarts";

import {
  chartCursorPointFromEChartsClick,
  chartRangeFromDataZoomEvent,
  type ChartCursorPoint,
  type ChartSeries,
  type ChartValueRange,
} from "../chartTableModel";
import {
  createChartFrameScheduler,
  type ChartFrameScheduler,
} from "./chartFrameScheduler";
import {
  recordChartDispatchDataZoom,
  recordChartDispatchPointClick,
  recordChartInstanceCreated,
  recordChartInstanceDisposed,
  recordChartResize,
} from "./chartDiagnostics";
import {
  cancelRangeCommit,
  chartStatusOverlay,
  type ChartRendererStatus,
  scheduleChartOptionUpdate,
  scheduleRangeCommit,
} from "./chartSurfaceModel";

interface EChartsSurfaceProps {
  dataStatus?: string;
  onPointSelect?: (point: ChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  series: readonly ChartSeries[];
  xAxisLabel?: string;
}

export function EChartsSurface({
  dataStatus,
  onPointSelect,
  onRangeChange,
  series,
  xAxisLabel,
}: EChartsSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const onPointSelectRef = useRef(onPointSelect);
  const onRangeChangeRef = useRef(onRangeChange);
  const rangeCommitTimerRef = useRef<number | null>(null);
  const resizeSchedulerRef = useRef<ChartFrameScheduler | null>(null);
  const setOptionSchedulerRef = useRef<ChartFrameScheduler | null>(null);
  const model = useMemo(() => series, [series]);
  const modelRef = useRef(model);
  const xAxisLabelRef = useRef(xAxisLabel);
  const [rendererStatus, setRendererStatus] = useReducer(
    (_status: ChartRendererStatus, nextStatus: ChartRendererStatus) =>
      nextStatus,
    "loading",
  );
  const updateRendererStatus = (status: ChartRendererStatus) => {
    setRendererStatus(status);
  };
  const hasSamples = series.some((item) => item.points.length > 0);
  const overlay = chartStatusOverlay({
    dataStatus,
    hasSamples,
    rendererStatus,
  });

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    onPointSelectRef.current = onPointSelect;
  }, [onPointSelect]);

  useEffect(() => {
    onRangeChangeRef.current = onRangeChange;
  }, [onRangeChange]);

  useEffect(() => {
    xAxisLabelRef.current = xAxisLabel;
  }, [xAxisLabel]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    let cleanupChartEvents: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const resizeScheduler = createChartFrameScheduler();
    const setOptionScheduler = createChartFrameScheduler();
    resizeSchedulerRef.current = resizeScheduler;
    setOptionSchedulerRef.current = setOptionScheduler;

    void import("echarts")
      .then((echarts) => {
        if (disposed) return;
        let chart: ECharts;
        try {
          chart = echarts.init(element, undefined, { renderer: "canvas" });
        } catch {
          if (!disposed) updateRendererStatus("error");
          return;
        }
        chartRef.current = chart;
        recordChartInstanceCreated();
        if (onRangeChangeRef.current) {
          recordChartDispatchDataZoom(chart);
        }
        recordChartDispatchPointClick((seriesIndex, dataIndex) => {
          const point = chartCursorPointFromEChartsClick(
            { dataIndex, seriesIndex },
            modelRef.current,
          );
          if (!point) return;
          onPointSelectRef.current?.(point);
        });
        updateRendererStatus("ready");
        if (modelRef.current.length > 0) {
          scheduleChartOptionUpdate({
            chart,
            element,
            scheduler: setOptionScheduler,
            series: modelRef.current,
            xAxisLabel: xAxisLabelRef.current,
          });
        }
        const handleDataZoom = (event: unknown) => {
          const range = chartRangeFromDataZoomEvent(event);
          if (!range) return;
          scheduleRangeCommit(rangeCommitTimerRef, () => {
            onRangeChangeRef.current?.(range);
          });
        };
        const selectChartPoint = (event: unknown) => {
          const point = chartCursorPointFromEChartsClick(
            event,
            modelRef.current,
          );
          if (!point) return;
          onPointSelectRef.current?.(point);
        };
        chart.on("dataZoom", handleDataZoom);
        chart.on("click", selectChartPoint);
        cleanupChartEvents = () => {
          chart.off("dataZoom", handleDataZoom);
          chart.off("click", selectChartPoint);
        };
        resizeObserver = new ResizeObserver(() => {
          resizeScheduler.schedule(() => {
            recordChartResize();
            chart.resize();
          });
        });
        resizeObserver.observe(element);
      })
      .catch(() => {
        if (!disposed) updateRendererStatus("error");
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      resizeScheduler.cancel();
      setOptionScheduler.cancel();
      cancelRangeCommit(rangeCommitTimerRef);
      resizeSchedulerRef.current = null;
      setOptionSchedulerRef.current = null;
      cleanupChartEvents?.();
      const chart = chartRef.current;
      if (chart) {
        chart.off("dataZoom");
        chart.off("click");
        chart.dispose();
        recordChartInstanceDisposed();
      }
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (chartRef.current && element && model.length > 0) {
      scheduleChartOptionUpdate({
        chart: chartRef.current,
        element,
        scheduler: setOptionSchedulerRef.current,
        series: model,
        xAxisLabel,
      });
    }
  }, [model, xAxisLabel]);

  return (
    <div className="fm-analysis-plots__chart-frame">
      <div ref={elementRef} className="fm-analysis-plots__echarts" />
      {overlay ? (
        <div className="fm-analysis-plots__chart-empty" role={overlay.role}>
          {overlay.label}
        </div>
      ) : null}
    </div>
  );
}
