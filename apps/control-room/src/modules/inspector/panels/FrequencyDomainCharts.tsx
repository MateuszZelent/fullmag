"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Eye } from "lucide-react";

import type { ECharts, EChartsOption } from "echarts";

import type {
  EigenDispersionPoint,
  EigenSpectrumPoint,
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";

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
  onPlotMode,
  onSelectMode,
  selectedModeKey,
}: {
  model: FrequencyDomainChartBuildResult<EigenSpectrumPoint>;
  onPlotMode?: (point: EigenSpectrumPoint) => void;
  onSelectMode?: (point: EigenSpectrumPoint) => void;
  selectedModeKey?: string | null;
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
      dampingRateHz: point.dampingRateHz,
      frequencyLabel: `${formatNumber(frequencyValue)} ${frequencyUnit}`,
      frequencyValue,
      hasField: Boolean(point.modeFieldId),
      leakage: point.tangentLeakageMax,
      mode: point.rawModeIndex,
      name: `mode ${point.rawModeIndex}`,
      rowIndex,
      residualNorm: point.residualNorm,
      sample: point.sampleIndex,
      selected:
        selectedModeKey === `${point.sampleIndex}:${point.rawModeIndex}`,
    };
  });
  const resolvePoint = (event: unknown) => {
    const rowIndex = spectrumPointIndexFromChartEvent(event);
    return rowIndex == null ? null : model.points[rowIndex] ?? null;
  };

  return (
    <FrequencyDomainEChartsFrame
      droppedPointCount={model.droppedPointCount}
      onChartClick={(event) => {
        const point = resolvePoint(event);
        if (point) onSelectMode?.(point);
      }}
      onChartDoubleClick={(event) => {
        const point = resolvePoint(event);
        if (point) onPlotMode?.(point);
      }}
      option={buildSpectrumOption(data, frequencyUnit)}
      pointCount={data.length}
      title="FMR / eigen modal spectrum"
    >
      {data.map((point) => (
        <Button
          aria-label={`Select mode ${point.mode} at ${point.frequencyLabel}, ${point.hasField ? "3D field available" : "3D field missing"}`}
          className="fm-frequency-domain-chart__mode"
          data-selected={point.selected ? "true" : undefined}
          key={`${point.sample}:${point.mode}`}
          size="sm"
          type="button"
          variant={point.selected ? "primary" : "secondary"}
          onClick={() => onSelectMode?.(model.points[point.rowIndex]!)}
          onDoubleClick={() => onPlotMode?.(model.points[point.rowIndex]!)}
        >
          <Eye aria-hidden="true" size={13} />
          <span>
            mode {point.mode}: {point.frequencyLabel}
          </span>
          <small>
            {point.hasField ? "3D ready" : "field missing"}
            {point.residualNorm != null
              ? ` | residual ${formatNumber(point.residualNorm)}`
              : ""}
            {point.dampingRateHz != null
              ? ` | damping ${formatNumber(point.dampingRateHz)} Hz`
              : ""}
            {point.leakage != null
              ? ` | leakage ${formatNumber(point.leakage)}`
              : ""}
          </small>
        </Button>
      ))}
    </FrequencyDomainEChartsFrame>
  );
}

export function FrequencyDomainDispersionChart({
  model,
  onSelectPoint,
}: {
  model: FrequencyDomainChartBuildResult<EigenDispersionPoint>;
  onSelectPoint?: (point: EigenDispersionPoint) => void;
}) {
  const resolvePoint = (event: unknown) => {
    const rowIndex = frequencyDomainSeriesPointIndexFromChartEvent(event);
    return rowIndex == null ? null : model.points[rowIndex] ?? null;
  };

  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      onChartClick={(event) => {
        const point = resolvePoint(event);
        if (point) onSelectPoint?.(point);
      }}
      series={model.series}
      title="Bloch / Floquet dispersion"
      xLabel="k-path s [rad/m]"
    >
      {model.points.slice(0, 4).map((point) => (
        <Button
          aria-label={`Select dispersion sample ${point.sampleIndex} mode ${point.rawModeIndex}`}
          className="fm-frequency-domain-chart__mode"
          key={`${point.sampleIndex}:${point.rawModeIndex}:${point.pathS}`}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onSelectPoint?.(point)}
        >
          <Eye aria-hidden="true" size={13} />
          <span>
            sample {point.sampleIndex}, mode {point.rawModeIndex}
          </span>
          <small>
            {formatFrequencyHz(point.frequencyHz)}
            {point.branchId ? ` | branch ${point.branchId}` : ""}
          </small>
        </Button>
      ))}
    </FrequencyDomainSeriesChart>
  );
}

export function FrequencyDomainResponseChart({
  model,
  onPlotPoint,
  onSelectPoint,
}: {
  model: FrequencyDomainChartBuildResult<FrequencyResponsePoint>;
  onPlotPoint?: (point: FrequencyResponsePoint) => void;
  onSelectPoint?: (point: FrequencyResponsePoint) => void;
}) {
  const resolvePoint = (event: unknown) => {
    const rowIndex = frequencyDomainSeriesPointIndexFromChartEvent(event);
    return rowIndex == null ? null : model.points[rowIndex] ?? null;
  };

  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      onChartClick={(event) => {
        const point = resolvePoint(event);
        if (point) onSelectPoint?.(point);
      }}
      onChartDoubleClick={(event) => {
        const point = resolvePoint(event);
        if (point) onPlotPoint?.(point);
      }}
      series={model.series}
      title="Driven FMR frequency response"
      xLabel="frequency"
    >
      {model.points.slice(0, 4).map((point, index) => {
        const pointIndex = point.frequencyIndex ?? index;
        const frequencyLabel = formatFrequencyHz(point.frequencyHz);
        return (
          <div
            className="fm-frequency-domain-chart__point-actions"
            key={`${point.observableId}:${pointIndex}:${point.frequencyHz}`}
          >
            <Button
              aria-label={`Select response point ${pointIndex} at ${frequencyLabel}`}
              className="fm-frequency-domain-chart__mode"
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onSelectPoint?.(point)}
            >
              <Eye aria-hidden="true" size={13} />
              <span>
                {point.observableId}: {frequencyLabel}
              </span>
              <small>{point.fieldId ? "field ready" : "field missing"}</small>
            </Button>
            <Button
              aria-label={`Plot response field ${pointIndex} at ${frequencyLabel}`}
              className="fm-frequency-domain-chart__mode"
              disabled={!point.fieldId}
              size="sm"
              title={point.fieldId ? "Plot response field in 3D" : "Response field missing"}
              type="button"
              variant="secondary"
              onClick={() => onPlotPoint?.(point)}
            >
              Plot field
            </Button>
          </div>
        );
      })}
    </FrequencyDomainSeriesChart>
  );
}

function FrequencyDomainSeriesChart({
  children,
  droppedPointCount,
  onChartClick,
  onChartDoubleClick,
  series,
  title,
  xLabel,
}: {
  children?: ReactNode;
  droppedPointCount: number;
  onChartClick?: (event: unknown) => void;
  onChartDoubleClick?: (event: unknown) => void;
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
      onChartClick={onChartClick}
      onChartDoubleClick={onChartDoubleClick}
      option={buildFrequencyDomainSeriesOption(chartSeries, xLabel)}
      pointCount={pointCount}
      title={title}
    >
      {chartSeries.slice(0, 4).map((entry) => (
        <span key={entry.id}>
          {entry.label}: {entry.points.length} samples
        </span>
      ))}
      {children}
    </FrequencyDomainEChartsFrame>
  );
}

function FrequencyDomainEChartsFrame({
  children,
  droppedPointCount,
  onChartClick,
  onChartDoubleClick,
  option,
  pointCount,
  title,
}: {
  children: ReactNode;
  droppedPointCount: number;
  onChartClick?: (event: unknown) => void;
  onChartDoubleClick?: (event: unknown) => void;
  option: EChartsOption;
  pointCount: number;
  title: string;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const clickRef = useRef(onChartClick);
  const doubleClickRef = useRef(onChartDoubleClick);
  const optionRef = useRef(option);

  useEffect(() => {
    optionRef.current = option;
  }, [option]);
  useEffect(() => {
    clickRef.current = onChartClick;
    doubleClickRef.current = onChartDoubleClick;
  }, [onChartClick, onChartDoubleClick]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const selectChartPoint = (event: unknown) => clickRef.current?.(event);
    const inspectChartPoint = (event: unknown) =>
      doubleClickRef.current?.(event);

    void import("echarts")
      .then((echarts) => {
        if (disposed) return;
        const chart = echarts.init(element, undefined, { renderer: "canvas" });
        chartRef.current = chart;
        chart.on("click", selectChartPoint);
        chart.on("dblclick", inspectChartPoint);
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
      chartRef.current?.off("click", selectChartPoint);
      chartRef.current?.off("dblclick", inspectChartPoint);
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

export function spectrumPointIndexFromChartEvent(event: unknown): number | null {
  const data =
    event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : null;
  if (!Array.isArray(data)) return null;
  const rowIndex = data[2];
  return typeof rowIndex === "number" && Number.isInteger(rowIndex)
    ? rowIndex
    : null;
}

export function frequencyDomainSeriesPointIndexFromChartEvent(
  event: unknown,
): number | null {
  const data =
    event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : null;
  const value =
    data && typeof data === "object" && !Array.isArray(data) && "value" in data
      ? (data as { value?: unknown }).value
      : data;
  if (!Array.isArray(value)) return null;
  const rowIndex = value[2];
  return typeof rowIndex === "number" && Number.isInteger(rowIndex)
    ? rowIndex
    : null;
}

export function buildSpectrumOption(
  data: {
    dampingRateHz?: number | null;
    frequencyValue: number;
    leakage?: number | null;
    mode: number;
    name: string;
    rowIndex: number;
    residualNorm?: number | null;
    sample: number;
    selected: boolean;
  }[],
  frequencyUnit: string,
): EChartsOption {
  const frequencyLabel = `frequency [${frequencyUnit}]`;
  const qualitySeries = [
    {
      id: "residual",
      label: "Residual",
      values: data.map((point) => point.residualNorm ?? null),
    },
    {
      id: "damping",
      label: "Damping [Hz]",
      values: data.map((point) => point.dampingRateHz ?? null),
    },
    {
      id: "leakage",
      label: "Tangent leakage",
      values: data.map((point) => point.leakage ?? null),
    },
  ].find((series) => series.values.some((value) => finiteNumber(value) != null));
  const yAxis = qualitySeries
    ? ([
        yValueAxis(frequencyLabel),
        {
          name: qualitySeries.label,
          nameTextStyle: { color: "var(--fm-text-muted)" },
          splitLine: { show: false },
          type: "value",
        },
      ] as EChartsOption["yAxis"])
    : yValueAxis(frequencyLabel);
  return {
    animation: false,
    color: qualitySeries ? [CHART_COLORS[0], CHART_COLORS[3]] : [CHART_COLORS[0]],
    grid: chartGrid(),
    legend: qualitySeries
      ? {
          icon: "circle",
          textStyle: { color: "var(--fm-text-primary)" },
          top: 0,
        }
      : undefined,
    series: [
      {
        data: data.map((point) => ({
          itemStyle: point.selected
            ? {
                borderColor: "var(--fm-accent)",
                borderWidth: 2,
                color: "var(--fm-chart-yellow)",
              }
            : undefined,
          name: point.name,
          value: [point.mode, point.frequencyValue, point.rowIndex],
        })),
        itemStyle: { borderRadius: [5, 5, 0, 0] },
        name: frequencyLabel,
        type: "bar",
      },
      ...(qualitySeries
        ? [
            {
              data: data.map((point, index) => [
                point.mode,
                qualitySeries.values[index],
                point.rowIndex,
              ]),
              lineStyle: { width: 2 },
              name: qualitySeries.label,
              showSymbol: true,
              symbolSize: 6,
              type: "line" as const,
              yAxisIndex: 1,
            },
          ]
        : []),
    ],
    tooltip: chartTooltip("mode"),
    xAxis: xValueAxis("mode"),
    yAxis,
  };
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
      data: entry.points.map((point) => ({
        value: [point.x, point.y, point.rowIndex],
      })),
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
