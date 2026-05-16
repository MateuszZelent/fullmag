"use client";

/**
 * DynamicEChart — SSR-safe ECharts wrapper.
 *
 * Initialises an `echarts.ECharts` instance inside a ref-tracked `div`.
 * Automatically handles resize observation and disposal on unmount.
 * All chart configuration is driven via the `option` prop.
 *
 * This replaces `DynamicPlot` (Plotly) for all 2D charting in the app.
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { ECHARTS_THEME } from "@/lib/echartsTheme";

export interface DynamicEChartProps {
  option: echarts.EChartsOption;
  className?: string;
  style?: React.CSSProperties;
  notMerge?: boolean;
  onClick?: (params: echarts.ECElementEvent) => void;
}

export default function DynamicEChart({
  option,
  className,
  style,
  notMerge = false,
  onClick,
}: DynamicEChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // Init / dispose
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      chart.resize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // Apply option
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption(option, { notMerge });
  }, [option, notMerge]);

  // Click handler
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    if (!onClick) return;
    chart.on("click", onClick);
    return () => {
      if (!chart.isDisposed()) {
        chart.off("click", onClick);
      }
    };
  }, [onClick]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%", minHeight: 200, ...style }}
    />
  );
}

export { ECHARTS_THEME };
