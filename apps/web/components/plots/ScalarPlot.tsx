"use client";

/**
 * ScalarPlot – ECharts line chart for time-series data.
 *
 * 1:1 port of amumax table-plot.ts adapted for fullmag's scalar_rows format.
 * Shows a line chart with optional column selection.
 *
 * PERF: Chart initialization and data updates are split into separate effects.
 *       Data updates use `notMerge: false` to only replace series data without
 *       re-creating axes/tooltip/theme. The rows-to-series transform is
 *       throttled to max ~4 Hz to avoid blocking the main thread on fast SSE.
 */

import { useEffect, useRef, useCallback, memo } from "react";
import type { ECharts } from "echarts";
import * as echarts from "echarts";
import type { ScalarRow } from "../../lib/useSessionStream";

// ─── Theme — reads CSS custom properties for consistency ───────────
function getTheme() {
  // Hardcoded to match the exact Shadcn Midnight palette mapped in globals.css
  // This avoids slow `getComputedStyle` DOM queries which block rendering.
  return {
    bg: "transparent",
    surface1: "hsla(222.2, 84%, 4.9%, 0.8)", // bg-card
    border: "hsla(217.2, 32.6%, 17.5%, 0.5)", // border
    text1: "hsla(210, 40%, 98%, 1)", // foreground
    text2: "hsla(215, 20.2%, 65.1%, 1)", // muted-foreground
    text3: "hsla(215, 20.2%, 65.1%, 0.5)",
    accent: "hsla(217.2, 91.2%, 59.8%, 1)", // primary
    tooltipBg: "hsla(222.2, 84%, 4.9%, 0.95)", // popover
    tooltipBorder: "hsla(217.2, 32.6%, 17.5%, 1)", // border
    tooltipText: "hsla(210, 40%, 98%, 1)",
    toolboxIcon: "hsla(215, 20.2%, 65.1%, 1)",
    brushBg: "hsla(217.2, 91.2%, 59.8%, 0.15)",
    brushBorder: "hsla(217.2, 91.2%, 59.8%, 1)",
  };
}

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
  mx: "m_x avg",
  my: "m_y avg",
  mz: "m_z avg",
  e_ex: "E_exchange (J)",
  e_demag: "E_demag (J)",
  e_ext: "E_external (J)",
  e_total: "E_total (J)",
  max_dm_dt: "max dm/dt (rad/s)",
  max_h_eff: "max |H_eff| (A/m)",
  max_h_demag: "max |H_demag| (A/m)",
};

function isMagnetizationAverageColumn(column: string): boolean {
  return column === "mx" || column === "my" || column === "mz";
}

const accessor = (row: ScalarRow, key: string): number =>
  (row as unknown as Record<string, number>)[key] ?? 0;

/** Build the static chart config (axes, tooltip, legend, toolbox). */
function buildChartConfig(xColumn: string, yColumns: string[], theme: ReturnType<typeof getTheme>) {
  const xLabel = COLUMN_LABELS[xColumn] ?? xColumn;
  const magnetizationOnly = yColumns.length > 0 && yColumns.every(isMagnetizationAverageColumn);
  return {
    animation: false,
    axisPointer: {
      show: true,
      type: "line" as const,
      lineStyle: { color: theme.accent, width: 2, type: "dashed" as const },
      label: {
        backgroundColor: theme.tooltipBg,
        color: theme.tooltipText,
        formatter: (params: any) => parseFloat(params.value).toPrecision(3),
        padding: [8, 5, 8, 5],
        borderColor: theme.accent,
        borderWidth: 1,
      },
    },
    tooltip: {
      trigger: "axis" as const,
      confine: true,
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: theme.tooltipText, fontSize: 12 },
        formatter: (params: any) => {
        if (!Array.isArray(params)) return "";
        const xVal = params[0]?.value?.[0];
        let html = `<strong>${xLabel}: ${Number(xVal).toExponential(3)}</strong>`;
        for (const p of params) {
          const yVal = Number(p.value[1]);
          html += `<br/>● ${p.seriesName}: ${
            magnetizationOnly ? yVal.toFixed(4) : yVal.toExponential(4)
          }`;
        }
        return html;
      },
    },
    legend: {
      show: yColumns.length > 1,
      bottom: 0,
      textStyle: { color: theme.text2, fontSize: 11 },
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
      nameLocation: "middle" as const,
      nameGap: 25,
      nameTextStyle: { color: theme.text2 },
      axisTick: {
        alignWithLabel: true,
        length: 6,
        lineStyle: { type: "solid" as const, color: theme.border },
      },
      axisLabel: {
        show: true,
        formatter: (value: number) =>
          Math.abs(value) >= 1e-3 || value === 0
            ? Number(value).toPrecision(3)
            : Number(value).toExponential(1),
        color: theme.text2,
      },
      axisLine: { lineStyle: { color: theme.border } },
      splitLine: { show: false },
    },
    yAxis: {
      nameLocation: "middle" as const,
      nameGap: 55,
      nameTextStyle: { color: theme.text2 },
      axisTick: {
        alignWithLabel: true,
        length: 6,
        lineStyle: { type: "solid" as const, color: theme.border },
      },
      axisLabel: {
        show: true,
        formatter: (value: number) => magnetizationOnly
          ? Number(value).toFixed(2)
          : Number(value).toExponential(2),
        color: theme.text2,
      },
      axisLine: { lineStyle: { color: theme.border } },
      splitLine: {
        show: true,
        lineStyle: { color: theme.border, type: "dashed" as const, opacity: 0.4 },
      },
    },
    toolbox: {
      show: true,
      top: 6,
      right: 10,
      itemSize: 18,
      itemGap: 10,
      iconStyle: { borderColor: theme.toolboxIcon, borderWidth: 1 },
      emphasis: { iconStyle: { borderColor: theme.text1 } },
      feature: {
        dataZoom: {
          xAxisIndex: 0,
          yAxisIndex: 0,
          brushStyle: {
            color: theme.brushBg,
            borderColor: theme.brushBorder,
            borderWidth: 2,
          },
        },
        restore: { show: true },
        saveAsImage: { type: "png" as const, name: "scalar_plot" },
      },
    },
    series: yColumns.map((col, i) => ({
      type: "line" as const,
      name: COLUMN_LABELS[col] ?? col,
      showSymbol: false,
      sampling: "lttb" as const,
      progressive: 2000,
      progressiveThreshold: 3000,
      animation: false,
      lineStyle: { width: 1.5 },
      itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
      data: [] as [number, number][],
    })),
  };
}

/* ── Component (memoized to block parent re-renders from propagating) ── */

const ScalarPlot = memo(function ScalarPlot({
  rows,
  xColumn = "time",
  yColumns = DEFAULT_Y_COLUMNS,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const initColumnsRef = useRef<string>("");
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRowsRef = useRef<ScalarRow[] | null>(null);

  // ─── Flush pending data to the chart ──────────────────────────────
  const flushData = useCallback(() => {
    const chart = chartRef.current;
    const rows = pendingRowsRef.current;
    throttleRef.current = null;
    if (!chart || chart.isDisposed() || !rows?.length) return;

    const columnsKey = initColumnsRef.current;
    const cols = columnsKey.split(",");
    const xCol = cols[0];
    const yCols = cols.slice(1);

    chart.setOption(
      {
        series: yCols.map((col) => ({
          data: rows.map((row) => [accessor(row, xCol), accessor(row, col)]),
        })),
      },
      { notMerge: false, lazyUpdate: true },
    );
  }, []);

  // ─── Init chart when columns change ───────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const columnsKey = `${xColumn},${yColumns.join(",")}`;
    const needsReinit =
      !chartRef.current ||
      chartRef.current.isDisposed() ||
      initColumnsRef.current !== columnsKey;

    if (!needsReinit) return;

    // Dispose old chart only if it exists
    if (chartRef.current && !chartRef.current.isDisposed()) {
      chartRef.current.dispose();
    }

    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    initColumnsRef.current = columnsKey;

    const theme = getTheme();
    chart.setOption(buildChartConfig(xColumn, yColumns, theme), { notMerge: true });

    // Flush any rows that were already available
    if (rows.length) {
      pendingRowsRef.current = rows;
      flushData();
    }

    return () => {
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, [xColumn, yColumns, flushData, rows]);

  // ─── Update data (throttled ~4 Hz) ────────────────────────────────
  useEffect(() => {
    if (!chartRef.current || chartRef.current.isDisposed() || !rows.length) return;

    pendingRowsRef.current = rows;

    // If no throttle is pending, schedule one
    if (!throttleRef.current) {
      throttleRef.current = setTimeout(flushData, 250);
    }
  }, [rows, flushData]);

  // ─── Resize observer ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    
    // Create an explicit instance resize function
    const handleResize = () => {
      if (chartRef.current && !chartRef.current.isDisposed()) {
        const width = el.clientWidth;
        const height = el.clientHeight;
        if (width > 0 && height > 0) {
          chartRef.current.resize({ width, height });
        }
      }
    };

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(handleResize);
    });
    
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  // ─── Cleanup ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      if (chartRef.current && !chartRef.current.isDisposed()) {
        chartRef.current.dispose();
      }
      chartRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full rounded-md border border-border/50 bg-card/40 backdrop-blur-md"
    />
  );
});

export default ScalarPlot;
