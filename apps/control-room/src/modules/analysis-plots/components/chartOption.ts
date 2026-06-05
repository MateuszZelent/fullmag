import type { EChartsOption } from "echarts";

import type { ChartSeries } from "../chartTableModel";

export function buildChartOption(
  chartSeries: readonly ChartSeries[],
  { xAxisLabel }: { xAxisLabel?: string },
  palette: readonly string[],
): EChartsOption {
  const yAxisGroups = groupChartSeriesByUnit(chartSeries);
  const axisIndexBySeriesId = new Map(
    yAxisGroups.flatMap((group) =>
      group.seriesIds.map((seriesId) => [seriesId, group.axisIndex] as const),
    ),
  );
  return {
    animation: false,
    color: [...palette],
    grid: {
      bottom: 64,
      containLabel: true,
      left: 16,
      right: yAxisGroups.length > 1 ? 16 : 24,
      top: 48,
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
        fillerColor: "var(--fm-border-muted)",
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
    series: chartSeries.map((series) => ({
      data: series.points.map((point) => [point.x, point.y]),
      lineStyle: { width: 2 },
      name: formatSeriesName(series),
      progressive: 0,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 4,
      type: "line",
      yAxisIndex: axisIndexBySeriesId.get(series.id) ?? 0,
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
      name: xAxisLabel ?? "x",
      nameGap: 28,
      nameLocation: "middle",
      nameTextStyle: { color: "var(--fm-text-secondary)" },
      splitLine: { show: false },
      type: "value",
    },
    yAxis: yAxisGroups.map((axis, index) => ({
      alignTicks: true,
      axisLabel: {
        color: "var(--fm-text-muted)",
        formatter: (value: number | string) =>
          typeof value === "number" ? formatChartNumber(value) : String(value),
      },
      axisLine: { show: false },
      axisTick: { show: false },
      name: axis.unit ? `[${axis.unit}]` : "",
      nameTextStyle: {
        align: index === 0 ? "left" : "right",
        color: "var(--fm-text-secondary)",
        padding: index === 0 ? [0, 0, 0, -24] : [0, -24, 0, 0],
      },
      position: index === 0 ? "left" : "right",
      splitLine: {
        lineStyle: { color: "var(--fm-border-subtle)", type: "solid" },
        show: true,
      },
      type: "value",
    })),
  };
}

function groupChartSeriesByUnit(
  chartSeries: readonly ChartSeries[],
): { axisIndex: number; seriesIds: string[]; unit: string }[] {
  const groups: { axisIndex: number; seriesIds: string[]; unit: string }[] = [];
  const groupsByUnit = new Map<
    string,
    { axisIndex: number; seriesIds: string[]; unit: string }
  >();
  for (const series of chartSeries) {
    let group = groupsByUnit.get(series.unit);
    if (!group) {
      if (groups.length >= 2) continue;
      group = { axisIndex: groups.length, seriesIds: [], unit: series.unit };
      groups.push(group);
      groupsByUnit.set(series.unit, group);
    }
    group.seriesIds.push(series.id);
  }
  return groups.length > 0 ? groups : [{ axisIndex: 0, seriesIds: [], unit: "" }];
}

function formatSeriesName(series: ChartSeries): string {
  return series.unit
    ? `${series.label || series.quantity} [${series.unit}]`
    : (series.label || series.quantity);
}

function formatChartNumber(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  return value.toPrecision(5);
}
