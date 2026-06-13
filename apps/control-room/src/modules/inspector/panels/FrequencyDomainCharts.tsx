"use client";

import { useEffect, useRef, type ReactNode } from "react";

import type { ECharts, EChartsOption } from "echarts";

import type {
  EigenDispersionPoint,
  EigenSpectrumPoint,
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

const CHART_COLORS = [
  "var(--fm-chart-blue)",
  "var(--fm-chart-green)",
  "var(--fm-chart-yellow)",
  "var(--fm-chart-red)",
  "var(--fm-chart-mauve)",
] as const;

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(5)).toLocaleString("en-US");
}

export function FrequencyDomainSpectrumChart({
  model,
}: {
  model: FrequencyDomainChartBuildResult<EigenSpectrumPoint>;
}) {
  const frequencySeries = model.series.find(
    (series) => series.quantity === "frequency",
  );
  const frequencyUnit = frequencySeries?.unit ?? "Hz";
  const data = model.points.map((point, rowIndex) => {
    const frequencyValue =
      frequencySeries?.points.find((seriesPoint) => seriesPoint.rowIndex === rowIndex)
        ?.y ?? point.frequencyHz;
    return {
      dampingGHz:
        point.dampingRateHz == null ? null : Math.abs(point.dampingRateHz) / 1e9,
      frequencyLabel: `${formatNumber(frequencyValue)} ${frequencyUnit}`,
      frequencyValue,
      mode: point.rawModeIndex,
      name: `mode ${point.rawModeIndex}`,
      residualNorm: point.residualNorm,
      sample: point.sampleIndex,
    };
  });

  return (
    <FrequencyDomainEChartsFrame
      droppedPointCount={model.droppedPointCount}
      option={buildSpectrumOption(data, frequencyUnit)}
      pointCount={data.length}
      title="FMR / eigen modal spectrum"
    >
      {data.slice(0, 4).map((point) => (
        <span key={`${point.sample}:${point.mode}`}>
          mode {point.mode}: {point.frequencyLabel}
        </span>
      ))}
    </FrequencyDomainEChartsFrame>
  );
}

export function FrequencyDomainDispersionChart({
  model,
}: {
  model: FrequencyDomainChartBuildResult<EigenDispersionPoint>;
}) {
  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      series={model.series}
      title="Bloch / Floquet dispersion"
      xLabel="k-path s [rad/m]"
    />
  );
}

export function FrequencyDomainResponseChart({
  model,
}: {
  model: FrequencyDomainChartBuildResult<FrequencyResponsePoint>;
}) {
  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      series={model.series}
      title="Driven FMR frequency response"
      xLabel="frequency"
    />
  );
}

function FrequencyDomainSeriesChart({
  droppedPointCount,
  series,
  title,
  xLabel,
}: {
  droppedPointCount: number;
  series: readonly FrequencyDomainChartSeries[];
  title: string;
  xLabel: string;
}) {
  const chartSeries = series.filter((entry) => entry.points.length > 0);
  const pointCount = chartSeries.reduce(
    (count, entry) => count + entry.points.length,
    0,
  );

  return (
    <FrequencyDomainEChartsFrame
      droppedPointCount={droppedPointCount}
      option={buildFrequencyDomainSeriesOption(chartSeries, xLabel)}
      pointCount={pointCount}
      title={title}
    >
      {chartSeries.slice(0, 4).map((entry) => (
        <span key={entry.id}>
          {entry.label}: {entry.points.length} samples
        </span>
      ))}
    </FrequencyDomainEChartsFrame>
  );
}

function FrequencyDomainEChartsFrame({
  children,
  droppedPointCount,
  option,
  pointCount,
  title,
}: {
  children: ReactNode;
  droppedPointCount: number;
  option: EChartsOption;
  pointCount: number;
  title: string;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const optionRef = useRef(option);

  useEffect(() => {
    optionRef.current = option;
  }, [option]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void import("echarts")
      .then((echarts) => {
        if (disposed) return;
        const chart = echarts.init(element, undefined, { renderer: "canvas" });
        chartRef.current = chart;
        chart.setOption(optionRef.current, true);
        resizeObserver = new ResizeObserver(() => {
          requestAnimationFrame(() => {
            if (!disposed) chart.resize();
          });
        });
        resizeObserver.observe(element);
      })
      .catch(() => {
        if (!disposed) chartRef.current = null;
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return (
    <div
      aria-label={title}
      className="fm-frequency-domain-chart"
      data-renderer="echarts"
    >
      <div className="fm-frequency-domain-chart__header">
        <span>{title}</span>
        <small>
          ECharts, {pointCount} points
          {droppedPointCount > 0 ? `, ${droppedPointCount} dropped` : ""}
        </small>
      </div>
      {pointCount > 0 ? (
        <>
          <div ref={elementRef} className="fm-frequency-domain-chart__canvas" />
          <div className="fm-frequency-domain-chart__summary">{children}</div>
        </>
      ) : (
        <div className="fm-frequency-domain-chart__empty">
          No chartable frequency-domain samples.
        </div>
      )}
    </div>
  );
}

function buildSpectrumOption(
  data: {
    frequencyValue: number;
    mode: number;
    name: string;
    sample: number;
  }[],
  frequencyUnit: string,
): EChartsOption {
  const frequencyLabel = `frequency [${frequencyUnit}]`;
  return {
    animation: false,
    color: [CHART_COLORS[0]],
    grid: chartGrid(),
    series: [
      {
        data: data.map((point) => [point.mode, point.frequencyValue, point.name]),
        itemStyle: { borderRadius: [5, 5, 0, 0] },
        name: frequencyLabel,
        type: "bar",
      },
    ],
    tooltip: chartTooltip("mode"),
    xAxis: xValueAxis("mode"),
    yAxis: yValueAxis(frequencyLabel),
  };
}

export function buildFrequencyDomainSeriesOption(
  chartSeries: readonly FrequencyDomainChartSeries[],
  xLabel: string,
): EChartsOption {
  const resolvedXLabel = resolveSeriesXLabel(chartSeries, xLabel);
  return {
    animation: false,
    color: [...CHART_COLORS],
    grid: chartGrid(),
    legend: {
      icon: "circle",
      textStyle: { color: "var(--fm-text-primary)" },
      top: 0,
      type: "scroll",
    },
    series: chartSeries.map((entry) => ({
      data: entry.points.map((point) => [point.x, point.y]),
      lineStyle: { width: 2 },
      name: `${entry.label} [${entry.unit}]`,
      showSymbol: false,
      type: "line",
    })),
    tooltip: chartTooltip(resolvedXLabel),
    xAxis: xValueAxis(resolvedXLabel),
    yAxis: yValueAxis("response"),
  };
}

function resolveSeriesXLabel(
  chartSeries: readonly FrequencyDomainChartSeries[],
  xLabel: string,
): string {
  if (xLabel.includes("[")) return xLabel;
  const unit = chartSeries.find((entry) => entry.xUnit)?.xUnit;
  return unit ? `${xLabel} [${unit}]` : xLabel;
}

function chartGrid(): EChartsOption["grid"] {
  return {
    bottom: 42,
    containLabel: true,
    left: 8,
    right: 12,
    top: 36,
  };
}

function xValueAxis(name: string): EChartsOption["xAxis"] {
  return {
    axisLabel: {
      color: "var(--fm-text-muted)",
      formatter: (value: number | string) =>
        typeof value === "number" ? formatNumber(value) : String(value),
    },
    axisLine: { lineStyle: { color: "var(--fm-border-strong)" } },
    axisTick: { show: false },
    name,
    nameTextStyle: { color: "var(--fm-text-secondary)" },
    splitLine: { lineStyle: { color: "var(--fm-border-subtle)" } },
    type: "value",
  };
}

function yValueAxis(name: string): EChartsOption["yAxis"] {
  return {
    axisLabel: {
      color: "var(--fm-text-muted)",
      formatter: (value: number | string) =>
        typeof value === "number" ? formatNumber(value) : String(value),
    },
    axisLine: { lineStyle: { color: "var(--fm-border-strong)" } },
    axisTick: { show: false },
    name,
    nameTextStyle: { color: "var(--fm-text-secondary)" },
    splitLine: { lineStyle: { color: "var(--fm-border-subtle)" } },
    type: "value",
  };
}

function chartTooltip(axisLabel: string): EChartsOption["tooltip"] {
  return {
    axisPointer: {
      crossStyle: { color: "var(--fm-border-strong)", type: "dashed" },
      type: "cross",
    },
    backgroundColor: "var(--fm-bg-panel-raised)",
    borderColor: "var(--fm-border-default)",
    textStyle: { color: "var(--fm-text-primary)" },
    trigger: "axis",
    valueFormatter: (value) =>
      typeof value === "number" ? formatNumber(value) : String(value),
    formatter: (params) => {
      const items = Array.isArray(params) ? params : [params];
      return [
        `<strong>${axisLabel}</strong>`,
        ...items.map((item) => `${item.marker ?? ""}${item.seriesName}: ${item.value}`),
      ].join("<br/>");
    },
  };
}
