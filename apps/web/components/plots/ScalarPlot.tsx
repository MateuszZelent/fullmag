"use client";

/**
 * ScalarPlot – ECharts line chart for time-series data.
 *
 * 1:1 port of amumax table-plot.ts adapted for fullmag's scalar_rows format.
 * Shows a line chart with optional column selection.
 */

import { useEffect, useRef, useMemo } from "react";
import type { ECharts, EChartsOption } from "echarts";
import * as echarts from "echarts";
import type { ScalarRow } from "../../lib/useSessionStream";

// ─── Theme constants (from amumax echarts-theme.ts) ────────────────
const THEME = {
  bg: "#080d1a",
  surface1: "#0f172a",
  border: "#1e2d4a",
  text1: "#e2e8f0",
  text2: "#94a3b8",
  text3: "#5a6b8a",
  accent: "#3b82f6",
  info: "#60a5fa",
  tooltipBg: "#0f172a",
  tooltipBorder: "#3b82f6",
  tooltipText: "#e2e8f0",
  toolboxIcon: "#94a3b8",
  brushBg: "rgba(59, 130, 246, 0.15)",
  brushBorder: "#3b82f6",
};

const SERIES_COLORS = ["#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#fb923c", "#38bdf8", "#e879f9"];

interface Props {
  rows: ScalarRow[];
  xColumn?: string;
  yColumns?: string[];
}

const DEFAULT_Y_COLUMNS = ["e_ex", "e_demag", "e_ext", "e_total"];
const COLUMN_LABELS: Record<string, string> = {
  step: "Step",
  time: "Time (s)",
  solver_dt: "Δt (s)",
  e_ex: "E_exchange (J)",
  e_demag: "E_demag (J)",
  e_ext: "E_external (J)",
  e_total: "E_total (J)",
  max_dm_dt: "max dm/dt (rad/s)",
  max_h_eff: "max |H_eff| (A/m)",
  max_h_demag: "max |H_demag| (A/m)",
};

export default function ScalarPlot({
  rows,
  xColumn = "time",
  yColumns = DEFAULT_Y_COLUMNS,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // ─── Build series data ────────────────────────────────────────────
  const accessor = (row: ScalarRow, key: string): number =>
    (row as unknown as Record<string, number>)[key] ?? 0;

  const seriesData = useMemo(() => {
    if (!rows.length) return [];
    return yColumns.map((col, i) => ({
      type: "line" as const,
      name: COLUMN_LABELS[col] ?? col,
      showSymbol: false,
      sampling: "lttb" as const,
      progressive: 2000,
      progressiveThreshold: 3000,
      animation: false,
      lineStyle: { width: 1.5 },
      itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
      data: rows.map((row) => [accessor(row, xColumn), accessor(row, col)]),
    }));
  }, [rows, xColumn, yColumns]);

  // ─── Init / update chart ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !seriesData.length) return;

    if (!chartRef.current || chartRef.current.isDisposed()) {
      chartRef.current = echarts.init(containerRef.current, undefined, {
        renderer: "canvas",
      });
    }

    const chart = chartRef.current;
    const xLabel = COLUMN_LABELS[xColumn] ?? xColumn;

    chart.setOption(
      {
        animation: false,
        axisPointer: {
          show: true,
          type: "line",
          lineStyle: { color: THEME.accent, width: 2, type: "dashed" },
          label: {
            backgroundColor: THEME.tooltipBg,
            color: THEME.tooltipText,
            formatter: (params: any) => parseFloat(params.value).toPrecision(3),
            padding: [8, 5, 8, 5],
            borderColor: THEME.accent,
            borderWidth: 1,
          },
        },
        tooltip: {
          trigger: "axis",
          confine: true,
          backgroundColor: THEME.tooltipBg,
          borderColor: THEME.tooltipBorder,
          borderWidth: 1,
          textStyle: { color: THEME.tooltipText, fontSize: 12 },
          formatter: (params: any) => {
            if (!Array.isArray(params)) return "";
            const xVal = params[0]?.value?.[0];
            let html = `<strong>${xLabel}: ${Number(xVal).toExponential(3)}</strong>`;
            for (const p of params) {
              html += `<br/><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color};margin-right:4px;"></span>${p.seriesName}: ${Number(p.value[1]).toExponential(4)}`;
            }
            return html;
          },
        },
        legend: {
          show: yColumns.length > 1,
          bottom: 0,
          textStyle: { color: THEME.text2, fontSize: 11 },
          itemWidth: 16,
          itemHeight: 8,
          itemGap: 16,
        },
        grid: {
          containLabel: false,
          left: "12%",
          right: "6%",
          top: 32,
          bottom: yColumns.length > 1 ? 52 : 36,
        },
        xAxis: {
          name: xLabel,
          nameLocation: "middle",
          nameGap: 25,
          nameTextStyle: { color: THEME.text2 },
          axisTick: {
            alignWithLabel: true,
            length: 6,
            lineStyle: { type: "solid", color: THEME.border },
          },
          axisLabel: {
            show: true,
            formatter: (value: number) =>
              Math.abs(value) >= 1e-3 || value === 0
                ? Number(value).toPrecision(3)
                : Number(value).toExponential(1),
            color: THEME.text2,
          },
          axisLine: { lineStyle: { color: THEME.border } },
          splitLine: { show: false },
        },
        yAxis: {
          nameLocation: "middle",
          nameGap: 55,
          nameTextStyle: { color: THEME.text2 },
          axisTick: {
            alignWithLabel: true,
            length: 6,
            lineStyle: { type: "solid", color: THEME.border },
          },
          axisLabel: {
            show: true,
            formatter: (value: number) => Number(value).toExponential(2),
            color: THEME.text2,
          },
          axisLine: { lineStyle: { color: THEME.border } },
          splitLine: {
            show: true,
            lineStyle: { color: THEME.border, type: "dashed", opacity: 0.4 },
          },
        },
        toolbox: {
          show: true,
          top: 6,
          right: 10,
          itemSize: 18,
          itemGap: 10,
          iconStyle: { borderColor: THEME.toolboxIcon, borderWidth: 1 },
          emphasis: { iconStyle: { borderColor: THEME.text1 } },
          feature: {
            dataZoom: {
              xAxisIndex: 0,
              yAxisIndex: 0,
              brushStyle: {
                color: THEME.brushBg,
                borderColor: THEME.brushBorder,
                borderWidth: 2,
              },
            },
            restore: { show: true },
            saveAsImage: { type: "png", name: "scalar_plot" },
          },
        },
        series: seriesData,
      },
      { notMerge: true },
    );

    return () => {};
  }, [seriesData, xColumn, yColumns]);

  // ─── Resize observer ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // ─── Cleanup ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (chartRef.current && !chartRef.current.isDisposed()) {
        chartRef.current.dispose();
      }
      chartRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "320px",
        minHeight: "280px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
        background: "rgba(5, 9, 17, 0.65)",
      }}
    />
  );
}
