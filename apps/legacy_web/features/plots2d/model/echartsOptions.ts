/**
 * @module features/plots2d/model/echartsOptions
 *
 * Pure ECharts option builder for scalar time-series.
 *
 * This module is intentionally separated from the React component
 * so that options can be snapshot-tested independently.
 *
 * Uses the existing `ECHARTS_THEME` from `lib/echartsTheme.ts`.
 */

import type { EChartsOption } from "echarts";
import { ECHARTS_THEME } from "@/lib/echartsTheme";
import type { ScalarTable, ScalarSeriesMeta, XColumn, YScale } from "./plot2dTypes";

// ─────────────────────────────────────────────────────────────────
// Series palette (matching chartTypes.ts SERIES_PALETTE)
// ─────────────────────────────────────────────────────────────────

const SERIES_PALETTE = [
  "#60a5fa", // blue-400
  "#34d399", // emerald-400
  "#f472b6", // pink-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#fb923c", // orange-400
  "#38bdf8", // sky-400
  "#e879f9", // fuchsia-400
  "#4ade80", // green-400
  "#f87171", // red-400
  "#22d3ee", // cyan-400
  "#facc15", // yellow-400
] as const;

function seriesColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

// ─────────────────────────────────────────────────────────────────
// SI formatting
// ─────────────────────────────────────────────────────────────────

function formatSI(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e3 || abs < 1e-2) return value.toExponential(3);
  return value.toPrecision(5);
}

// ─────────────────────────────────────────────────────────────────
// Axis label formatting
// ─────────────────────────────────────────────────────────────────

function xAxisLabel(xColumn: XColumn): string {
  return xColumn === "time" ? "Time (s)" : "Step";
}

// ─────────────────────────────────────────────────────────────────
// Unit grouping for dual Y-axis
// ─────────────────────────────────────────────────────────────────

interface UnitGroup {
  unit: string;
  keys: string[];
  yAxisIndex: number;
}

function groupSeriesByUnit(
  seriesKeys: string[],
  metaByKey: Record<string, ScalarSeriesMeta>,
): UnitGroup[] {
  const unitMap = new Map<string, string[]>();

  for (const key of seriesKeys) {
    const unit = metaByKey[key]?.unit ?? "";
    const normalized = unit.trim().toLowerCase();
    const existing = unitMap.get(normalized);
    if (existing) {
      existing.push(key);
    } else {
      unitMap.set(normalized, [key]);
    }
  }

  return [...unitMap.entries()].map(([unit, keys], index) => ({
    unit,
    keys,
    yAxisIndex: Math.min(index, 1), // max 2 Y-axes
  }));
}

// ─────────────────────────────────────────────────────────────────
// Main option builder
// ─────────────────────────────────────────────────────────────────

export interface ScalarTimeSeriesInput {
  table: ScalarTable;
  seriesKeys: string[];
  xColumn: XColumn;
  yScale: YScale;
  showMarkers: boolean;
  showRangeSlider: boolean;
}

export function buildScalarTimeSeriesOption(input: ScalarTimeSeriesInput): EChartsOption {
  const {
    table,
    seriesKeys,
    xColumn,
    yScale,
    showMarkers,
    showRangeSlider,
  } = input;

  if (table.rowCount === 0 || seriesKeys.length === 0) {
    return buildEmptyOption(xColumn);
  }

  const xData = table.data[xColumn];
  if (!xData || xData.length === 0) {
    return buildEmptyOption(xColumn);
  }

  const unitGroups = groupSeriesByUnit(seriesKeys, table.metaByKey);
  const hasMultipleUnits = unitGroups.length > 1;

  // ── Build Y-axes ──
  const yAxes: EChartsOption["yAxis"] = [];
  const seenYAxisUnits = new Set<string>();

  for (const group of unitGroups) {
    if (seenYAxisUnits.has(String(group.yAxisIndex))) continue;
    seenYAxisUnits.add(String(group.yAxisIndex));

    yAxes.push({
      type: yScale === "log" ? "log" : "value",
      name: group.unit || undefined,
      nameTextStyle: {
        color: ECHARTS_THEME.text2,
        fontSize: 10,
        fontFamily: "IBM Plex Mono, monospace",
      },
      position: group.yAxisIndex === 0 ? "left" : "right",
      axisLine: {
        show: hasMultipleUnits,
        lineStyle: { color: ECHARTS_THEME.border },
      },
      axisLabel: {
        color: ECHARTS_THEME.text2,
        fontSize: 10,
        fontFamily: "IBM Plex Mono, monospace",
        formatter: (value: number) => formatSI(value),
      },
      splitLine: {
        lineStyle: {
          color: "rgba(108, 112, 134, 0.08)",
          type: "dashed",
        },
      },
    });
  }

  // Ensure we always have at least 2 Y-axes for stability
  while (yAxes.length < 2) {
    yAxes.push({
      type: yScale === "log" ? "log" : "value",
      show: false,
    });
  }

  // ── Build series ──
  const seriesMap = new Map<string, number>();
  for (const group of unitGroups) {
    for (const key of group.keys) {
      seriesMap.set(key, group.yAxisIndex);
    }
  }

  const series: EChartsOption["series"] = seriesKeys.map((key, idx) => {
    const meta = table.metaByKey[key];
    const yData = table.data[key];
    const color = seriesColor(idx);

    // For log scale, filter out non-positive values
    let data: [number, number][];
    if (yScale === "log" && yData) {
      data = [];
      for (let i = 0; i < Math.min(xData.length, yData.length); i++) {
        if (yData[i] > 0) {
          data.push([xData[i], yData[i]]);
        }
      }
    } else if (yData) {
      data = [];
      for (let i = 0; i < Math.min(xData.length, yData.length); i++) {
        data.push([xData[i], yData[i]]);
      }
    } else {
      data = [];
    }

    return {
      type: "line" as const,
      name: meta?.label ?? key,
      yAxisIndex: seriesMap.get(key) ?? 0,
      data,
      showSymbol: showMarkers,
      symbolSize: showMarkers ? 3 : 0,
      lineStyle: {
        color,
        width: 1.5,
      },
      itemStyle: {
        color,
      },
      emphasis: {
        lineStyle: { width: 2.5 },
      },
      sampling: xData.length > 5000 ? "lttb" : undefined,
      progressive: xData.length > 10000 ? 2000 : undefined,
    };
  });

  // ── dataZoom ──
  const dataZoom: EChartsOption["dataZoom"] = [
    {
      type: "inside",
      xAxisIndex: 0,
      filterMode: "none",
    },
  ];

  if (showRangeSlider) {
    dataZoom.push({
      type: "slider",
      xAxisIndex: 0,
      height: 24,
      bottom: 8,
      borderColor: ECHARTS_THEME.border,
      backgroundColor: "rgba(15, 22, 42, 0.6)",
      fillerColor: "rgba(87, 200, 182, 0.12)",
      handleStyle: {
        color: ECHARTS_THEME.accent,
        borderColor: ECHARTS_THEME.accent,
      },
      textStyle: {
        color: ECHARTS_THEME.text2,
        fontSize: 9,
        fontFamily: "IBM Plex Mono, monospace",
      },
      dataBackground: {
        lineStyle: { color: "rgba(87, 200, 182, 0.3)" },
        areaStyle: { color: "rgba(87, 200, 182, 0.05)" },
      },
    });
  }

  return {
    animation: false,
    backgroundColor: "transparent",
    grid: {
      top: 36,
      right: hasMultipleUnits ? 72 : 24,
      bottom: showRangeSlider ? 60 : 32,
      left: 72,
      containLabel: false,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: ECHARTS_THEME.tooltipBg,
      borderColor: ECHARTS_THEME.tooltipBorder,
      borderWidth: 1,
      textStyle: {
        color: ECHARTS_THEME.tooltipText,
        fontSize: 11,
        fontFamily: "IBM Plex Mono, monospace",
      },
      axisPointer: {
        type: "cross",
        crossStyle: {
          color: "rgba(87, 200, 182, 0.25)",
        },
        lineStyle: {
          color: "rgba(87, 200, 182, 0.25)",
          type: "dashed",
        },
      },
      formatter: (params: unknown) => formatTooltip(params, table.metaByKey),
    },
    legend: {
      show: seriesKeys.length > 1,
      top: 4,
      textStyle: {
        color: ECHARTS_THEME.text2,
        fontSize: 10,
        fontFamily: "Inter, sans-serif",
      },
      itemWidth: 16,
      itemHeight: 3,
      itemGap: 12,
    },
    xAxis: {
      type: "value",
      name: xAxisLabel(xColumn),
      nameLocation: "center",
      nameGap: 22,
      nameTextStyle: {
        color: ECHARTS_THEME.text2,
        fontSize: 10,
        fontFamily: "IBM Plex Mono, monospace",
      },
      axisLine: {
        lineStyle: { color: ECHARTS_THEME.border },
      },
      axisLabel: {
        color: ECHARTS_THEME.text2,
        fontSize: 10,
        fontFamily: "IBM Plex Mono, monospace",
        formatter: xColumn === "time" ? (v: number) => formatSI(v) : undefined,
      },
      splitLine: {
        lineStyle: {
          color: "rgba(108, 112, 134, 0.06)",
          type: "dashed",
        },
      },
    },
    yAxis: yAxes,
    series,
    dataZoom,
    toolbox: {
      show: true,
      right: 12,
      top: 4,
      itemSize: 13,
      iconStyle: {
        borderColor: ECHARTS_THEME.toolboxIcon,
      },
      feature: {
        saveAsImage: {
          pixelRatio: 2,
          title: "Export PNG",
          backgroundColor: "#0f1629",
        },
        restore: {
          title: "Reset zoom",
        },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Empty state option
// ─────────────────────────────────────────────────────────────────

function buildEmptyOption(xColumn: XColumn): EChartsOption {
  return {
    animation: false,
    backgroundColor: "transparent",
    grid: { top: 36, right: 24, bottom: 32, left: 72 },
    xAxis: {
      type: "value",
      name: xAxisLabel(xColumn),
      axisLine: { lineStyle: { color: ECHARTS_THEME.border } },
      axisLabel: { color: ECHARTS_THEME.text2 },
    },
    yAxis: {
      type: "value",
      axisLine: { lineStyle: { color: ECHARTS_THEME.border } },
      axisLabel: { color: ECHARTS_THEME.text2 },
    },
    graphic: {
      type: "text",
      left: "center",
      top: "center",
      style: {
        text: "No data available",
        fill: ECHARTS_THEME.text2,
        fontSize: 13,
        fontFamily: "Inter, sans-serif",
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Tooltip formatter
// ─────────────────────────────────────────────────────────────────

function formatTooltip(
  params: unknown,
  metaByKey: Record<string, ScalarSeriesMeta>,
): string {
  if (!Array.isArray(params) || params.length === 0) return "";

  const first = params[0] as { data?: [number, number]; axisValueLabel?: string };
  const xValue = first.data?.[0];
  const lines: string[] = [];

  if (xValue !== undefined) {
    lines.push(`<b style="color:${ECHARTS_THEME.text1}">${formatSI(xValue)}</b>`);
  }

  for (const p of params as Array<{
    seriesName?: string;
    data?: [number, number];
    color?: string;
    marker?: string;
  }>) {
    const value = p.data?.[1];
    if (value === undefined) continue;

    const name = p.seriesName ?? "?";
    const meta = Object.values(metaByKey).find((m) => m.label === name);
    const unit = meta?.unit ? ` ${meta.unit}` : "";

    lines.push(
      `${p.marker ?? ""} ${name}: <b>${formatSI(value)}</b>${unit}`,
    );
  }

  return lines.join("<br>");
}
