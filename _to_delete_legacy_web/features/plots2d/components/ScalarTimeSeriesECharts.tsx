"use client";

/**
 * @module features/plots2d/components/ScalarTimeSeriesECharts
 *
 * ECharts-based scalar time-series renderer.
 *
 * Uses raw `echarts.init()` without a React wrapper library
 * (same pattern as `MagnetizationSlice2D.tsx`).
 *
 * Key features:
 * - Canvas renderer for high-performance rendering
 * - Progressive rendering for >10k points
 * - Built-in dataZoom (scroll + slider)
 * - Dual Y-axis via unit grouping
 * - Log scale with non-positive value guard
 * - Dark theme integration via ECHARTS_THEME
 * - ResizeObserver for responsive sizing
 */

import { useEffect, useRef, useCallback } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  GraphicComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { buildScalarTimeSeriesOption } from "../model/echartsOptions";
import type { ScalarTable, XColumn, YScale } from "../model/plot2dTypes";

// Register ECharts components (tree-shaken)
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  GraphicComponent,
  CanvasRenderer,
]);

// ─────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────

export interface ScalarTimeSeriesEChartsProps {
  table: ScalarTable;
  seriesKeys: string[];
  xColumn: XColumn;
  yScale: YScale;
  showMarkers: boolean;
  showRangeSlider: boolean;
  /** Fingerprint for memoizing setOption calls. */
  optionFingerprint: string;
}

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────

export function ScalarTimeSeriesECharts({
  table,
  seriesKeys,
  xColumn,
  yScale,
  showMarkers,
  showRangeSlider,
  optionFingerprint,
}: ScalarTimeSeriesEChartsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // ── Init / dispose ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = echarts.init(el, undefined, {
      renderer: "canvas",
      useDirtyRect: true,
    });
    chartRef.current = chart;

    return () => {
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // ── Resize ──
  useEffect(() => {
    const el = containerRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;

    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // ── Update option ──
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const option = buildScalarTimeSeriesOption({
      table,
      seriesKeys,
      xColumn,
      yScale,
      showMarkers,
      showRangeSlider,
    });

    chart.setOption(option, {
      notMerge: true,
      lazyUpdate: true,
    });
  }, [optionFingerprint, table, seriesKeys, xColumn, yScale, showMarkers, showRangeSlider]);

  // ── Export PNG ──
  const handleExportPng = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.getDataURL({
      type: "png",
      pixelRatio: 2,
      backgroundColor: "#0f1629",
    });
    const link = document.createElement("a");
    link.href = url;
    link.download = "plot2d_export.png";
    link.click();
  }, []);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full"
        data-testid="scalar-time-series-echarts"
      />
    </div>
  );
}

export default ScalarTimeSeriesECharts;
