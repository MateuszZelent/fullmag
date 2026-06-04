"use client";

import { useEffect, useMemo, useRef } from "react";

import type { ECharts, EChartsOption } from "echarts";

import { buildChartSeriesModel, type TableRowsLike } from "../chartTableModel";

interface EChartsSurfaceProps {
  table: TableRowsLike | null;
  xAxisId?: string;
  yAxisIds?: readonly string[];
}

export function EChartsSurface({ table, xAxisId, yAxisIds }: EChartsSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const model = useMemo(() => table, [table]);
  const modelRef = useRef(model);
  const axesRef = useRef({ xAxisId, yAxisIds });
  const hasSamples = Boolean(table && table.rows.length > 0);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    axesRef.current = { xAxisId, yAxisIds };
  }, [xAxisId, yAxisIds]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void import("echarts").then((echarts) => {
      if (disposed) return;
      const chart = echarts.init(element, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      if (modelRef.current) {
        chart.setOption(
          buildChartOption(
            modelRef.current,
            axesRef.current,
            readChartPalette(element),
          ),
          true,
        );
      }
      resizeObserver = new ResizeObserver(() => chart.resize());
      resizeObserver.observe(element);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (chartRef.current && element && model) {
      chartRef.current.setOption(
        buildChartOption(model, { xAxisId, yAxisIds }, readChartPalette(element)),
        true,
      );
    }
  }, [model, xAxisId, yAxisIds]);

  return (
    <div className="fm-analysis-plots__chart-frame">
      <div ref={elementRef} className="fm-analysis-plots__echarts" />
      {!hasSamples ? (
        <div className="fm-analysis-plots__chart-empty">No table samples</div>
      ) : null}
    </div>
  );
}

function buildChartOption(
  table: TableRowsLike,
  { xAxisId, yAxisIds }: { xAxisId?: string; yAxisIds?: readonly string[] },
  palette: readonly string[],
): EChartsOption {
  const model = buildChartSeriesModel(table, { xAxisId, yAxisIds });
  return {
    animation: false,
    color: [...palette],
    dataset: model.dataset,

    grid: {
      bottom: 64, // Extra space for x-axis name and dataZoom
      containLabel: true,
      left: 16,
      right: model.yAxis.length > 1 ? 16 : 24,
      top: 48, // Extra space for legend and axis names
    },
    dataZoom: [
      { filterMode: "none", type: "inside" },
      {
        type: "slider",
        filterMode: "none",
        bottom: 8,
        height: 12,
        showDetail: false,
        showDataShadow: false,
        borderColor: "transparent",
        backgroundColor: "var(--fm-bg-surface)",
        fillerColor: "rgba(128, 128, 128, 0.15)",
        handleSize: "100%",
        handleStyle: {
          color: "var(--fm-border-strong)",
          borderWidth: 0,
        },
      },
    ],
    legend: {
      icon: "circle",
      itemGap: 24,
      textStyle: { color: "var(--fm-text-primary)" },
      top: 0,
      type: "scroll",
    },
    series: model.series.map((series) => ({
      ...series,
      lineStyle: { width: 2 },
      progressive: 0,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 4,
    })),
    tooltip: {
      axisPointer: {
        crossStyle: { color: "var(--fm-border-strong)", type: "dashed" },
        label: {
          backgroundColor: "var(--fm-bg-surface)",
          color: "var(--fm-text-primary)",
        },
        type: "cross",
      },
      backgroundColor: "var(--fm-bg-surface)",
      borderColor: "var(--fm-border-strong)",
      textStyle: { color: "var(--fm-text-primary)" },
      trigger: "axis",
      valueFormatter: (value) =>
        typeof value === "number" ? formatChartNumber(value) : String(value),
    },
    xAxis: {
      axisLabel: {
        color: "var(--fm-text-muted)",
        formatter: (value: number | string) =>
          typeof value === "number" ? formatChartNumber(value) : String(value),
      },
      axisLine: { lineStyle: { color: "var(--fm-border-strong)" } },
      axisTick: { show: false },
      name: model.xAxisId,
      nameGap: 28,
      nameLocation: "middle",
      nameTextStyle: { color: "var(--fm-text-secondary)" },
      splitLine: { show: false }, // Cleaner without vertical lines
      type: "value",
    },
    yAxis: model.yAxis.map((axis, index) => ({
      alignTicks: true,
      axisLabel: {
        color: "var(--fm-text-muted)",
        formatter: (value: number | string) =>
          typeof value === "number" ? formatChartNumber(value) : String(value),
      },
      axisLine: { show: false },
      axisTick: { show: false },
      name: axis.name ? `[${axis.name}]` : "",
      nameTextStyle: {
        align: index === 0 ? "left" : "right",
        color: "var(--fm-text-secondary)",
        padding: index === 0 ? [0, 0, 0, -24] : [0, -24, 0, 0],
      },
      position: index === 0 ? "left" : "right",
      splitLine: {
        lineStyle: { color: "var(--fm-border-subtle)", type: "solid" },
        show: true, // Show horizontal grid lines for all (alignTicks ensures they overlap)
      },
      type: "value",
    })),
  };
}

function readChartPalette(element: HTMLElement): string[] {
  const style = getComputedStyle(element);
  return [
    "--fm-chart-blue",
    "--fm-chart-green",
    "--fm-chart-yellow",
    "--fm-chart-red",
    "--fm-chart-mauve",
  ].map((token) => style.getPropertyValue(token).trim());
}

function formatChartNumber(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  return value.toPrecision(5);
}
