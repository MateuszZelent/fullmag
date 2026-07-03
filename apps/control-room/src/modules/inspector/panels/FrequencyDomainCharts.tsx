"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

const activeCharts: ECharts[] = [];

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
        ?.x ?? point.frequencyHz;
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
      {model.points.slice(0, 4).map((point) => {
        const pointLabel = dispersionPointLabel(point);
        return (
          <Button
            aria-label={`Select dispersion ${pointLabel}`}
            className="fm-frequency-domain-chart__mode"
            key={`${point.sampleIndex}:${point.rawModeIndex}:${point.pathS}`}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => onSelectPoint?.(point)}
          >
            <Eye aria-hidden="true" size={13} />
            <span>{pointLabel}</span>
            <small>
              {formatFrequencyHz(point.frequencyHz)}
              {point.branchId ? ` | branch ${point.branchId}` : ""}
              {point.linewidthHz != null
                ? ` | linewidth ${formatFrequencyHz(point.linewidthHz)}`
                : ""}
            </small>
          </Button>
        );
      })}
    </FrequencyDomainSeriesChart>
  );
}

function dispersionPointLabel(point: EigenDispersionPoint): string {
  const sample = `sample ${point.sampleIndex}`;
  const mode = `mode ${point.rawModeIndex}`;
  return point.sampleLabel
    ? `${point.sampleLabel} ${sample}, ${mode}`
    : `${sample}, ${mode}`;
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
  const observableOptions = useMemo(
    () => responseObservableOptions(model.points),
    [model.points],
  );
  const [selectedObservable, setSelectedObservable] = useState(
    () => observableOptions[0]?.value ?? "response",
  );
  const effectiveObservable =
    observableOptions.find((option) => option.value === selectedObservable)
      ?.value ??
    observableOptions[0]?.value ??
    "response";
  const quantityOptions = useMemo(
    () => responseQuantityOptions(model.series, model.points, effectiveObservable),
    [effectiveObservable, model.points, model.series],
  );
  const [selectedQuantity, setSelectedQuantity] = useState("amplitude");
  const effectiveQuantity =
    quantityOptions.find((option) => option.value === selectedQuantity)?.value ??
    quantityOptions[0]?.value ??
    "amplitude";
  const chartSeries = useMemo(
    () =>
      filterResponseChartSeries(
        model.series,
        model.points,
        effectiveObservable,
        effectiveQuantity,
      ),
    [effectiveObservable, effectiveQuantity, model.points, model.series],
  );
  const chartPoints = useMemo(
    () =>
      model.points.filter((point) => point.observableId === effectiveObservable),
    [effectiveObservable, model.points],
  );
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
      series={chartSeries}
      title="Driven FMR frequency response"
      xLabel="frequency"
    >
      <div className="fm-frequency-domain-chart__controls">
        <label className="fm-frequency-domain-chart__control">
          <span>Response component</span>
          <select
            aria-label="Response component"
            className="fm-inspector-select"
            value={effectiveObservable}
            onChange={(event) => setSelectedObservable(event.target.value)}
          >
            {observableOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fm-frequency-domain-chart__control">
          <span>Chart quantity</span>
          <select
            aria-label="Chart quantity"
            className="fm-inspector-select"
            value={effectiveQuantity}
            onChange={(event) => setSelectedQuantity(event.target.value)}
          >
            {quantityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} [{option.unit}]
              </option>
            ))}
          </select>
        </label>
      </div>
      {chartPoints.map((point, index) => {
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

interface ResponseChartOption {
  label: string;
  unit?: string;
  value: string;
}

function responseObservableOptions(
  points: readonly FrequencyResponsePoint[],
): ResponseChartOption[] {
  const seen = new Set<string>();
  const options: ResponseChartOption[] = [];
  for (const point of points) {
    if (seen.has(point.observableId)) continue;
    seen.add(point.observableId);
    options.push({
      label: responseObservableLabel(point.observableId),
      value: point.observableId,
    });
  }
  return options.length > 0
    ? options.toSorted((left, right) =>
        responseObservableSortKey(left.value) - responseObservableSortKey(right.value) ||
        left.label.localeCompare(right.label),
      )
    : [{ label: "response", value: "response" }];
}

function responseQuantityOptions(
  series: readonly FrequencyDomainChartSeries[],
  points: readonly FrequencyResponsePoint[],
  observableId: string,
): ResponseChartOption[] {
  const rowIndices = new Set(
    points.flatMap((point, rowIndex) =>
      point.observableId === observableId ? [rowIndex] : [],
    ),
  );
  const options = series.flatMap((entry) =>
    entry.points.some((point) => rowIndices.has(point.rowIndex))
      ? [
          {
            label: entry.label,
            unit: entry.unit,
            value: entry.quantity,
          },
        ]
      : [],
  );
  return options.length > 0
    ? options
    : [{ label: "Amplitude", unit: "a.u.", value: "amplitude" }];
}

function filterResponseChartSeries(
  series: readonly FrequencyDomainChartSeries[],
  points: readonly FrequencyResponsePoint[],
  observableId: string,
  quantity: string,
): FrequencyDomainChartSeries[] {
  const rowIndices = new Set(
    points.flatMap((point, rowIndex) =>
      point.observableId === observableId ? [rowIndex] : [],
    ),
  );
  return series.flatMap((entry) => {
    if (entry.quantity !== quantity) return [];
    const filteredPoints = entry.points.filter((point) =>
      rowIndices.has(point.rowIndex),
    );
    return filteredPoints.length > 0 ? [{ ...entry, points: filteredPoints }] : [];
  });
}

function responseObservableLabel(value: string): string {
  switch (value) {
    case "mx":
    case "m_x":
      return "mx";
    case "my":
    case "m_y":
      return "my";
    case "mz":
    case "m_z":
      return "mz";
    case "magnitude":
    case "mag":
    case "|m|":
      return "|m|";
    default:
      return value;
  }
}

function responseObservableSortKey(value: string): number {
  switch (responseObservableLabel(value)) {
    case "mx":
      return 0;
    case "my":
      return 1;
    case "mz":
      return 2;
    case "|m|":
      return 3;
    default:
      return 10;
  }
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

        // Enforce 4 concurrent ECharts instances budget
        if (activeCharts.length >= 4) {
          const oldestChart = activeCharts.shift();
          if (oldestChart) {
            try {
              oldestChart.dispose();
            } catch {
              // ignore already disposed
            }
          }
        }
        activeCharts.push(chart);

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
      if (chartRef.current) {
        const idx = activeCharts.indexOf(chartRef.current);
        if (idx !== -1) {
          activeCharts.splice(idx, 1);
        }
        chartRef.current.off("click", selectChartPoint);
        chartRef.current.off("dblclick", inspectChartPoint);
        chartRef.current.dispose();
        chartRef.current = null;
      }
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
  const hasDamping = data.some(
    (point) =>
      point.dampingRateHz != null &&
      Number.isFinite(point.dampingRateHz) &&
      point.dampingRateHz > 0,
  );

  // Build Lorentzian envelope when damping rates are available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envelopeSeries: any[] = [];
  if (hasDamping && data.length > 0) {
    const fMin = Math.min(...data.map((p) => p.frequencyValue));
    const fMax = Math.max(...data.map((p) => p.frequencyValue));
    const fRange = fMax - fMin || fMax * 0.1 || 1;
    const nSamples = 500;
    const fStart = fMin - fRange * 0.15;
    const fEnd = fMax + fRange * 0.15;
    const step = (fEnd - fStart) / nSamples;
    const envelopeData: [number, number][] = [];
    for (let i = 0; i <= nSamples; i++) {
      const f = fStart + step * i;
      let intensity = 0;
      for (const point of data) {
        const gamma = point.dampingRateHz ?? 0;
        if (gamma <= 0) continue;
        const halfGamma = gamma / 2;
        intensity += 1.0 / ((f - point.frequencyValue) ** 2 + halfGamma ** 2);
      }
      envelopeData.push([f, intensity]);
    }
    // Normalize envelope to [0, 1]
    let peakIntensity = 0;
    for (const [, y] of envelopeData) {
      if (y > peakIntensity) peakIntensity = y;
    }
    if (peakIntensity > 0) {
      for (const entry of envelopeData) {
        entry[1] /= peakIntensity;
      }
    }
    envelopeSeries.push({
      data: envelopeData,
      lineStyle: { width: 2 },
      name: "Spectral envelope",
      showSymbol: false,
      smooth: true,
      type: "line",
      areaStyle: {
        color: "var(--fm-chart-blue)",
        opacity: 0.15,
      },
      z: 0,
    });
  }

  return {
    animation: false,
    color: [CHART_COLORS[0], CHART_COLORS[3]],
    grid: chartGrid(),
    legend: {
      icon: "circle",
      textStyle: { color: "var(--fm-text-primary)" },
      top: 0,
    },
    series: [
      ...envelopeSeries,
      {
        data: data.map((point) => ({
          itemStyle: point.selected
            ? {
                borderColor: "var(--fm-accent)",
                borderWidth: 2,
                color: "var(--fm-chart-yellow)",
              }
            : { color: CHART_COLORS[0] },
          name: point.name,
          value: [point.frequencyValue, hasDamping ? 1.0 : 1.0, point.rowIndex],
        })),
        name: "Modes",
        symbolSize: (value: number[]) => {
          const rowIndex = value[2];
          const point = data.find((d) => d.rowIndex === rowIndex);
          return point?.selected ? 14 : 10;
        },
        type: "scatter",
        z: 1,
      },
    ],
    tooltip: chartTooltip(frequencyLabel),
    xAxis: xValueAxis(frequencyLabel),
    yAxis: hasDamping
      ? yValueAxis("intensity [a.u.]")
      : {
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          max: 2,
          min: 0,
          splitLine: { show: false },
          type: "value" as const,
        },
  };
}

export function buildFrequencyDomainSeriesOption(
  chartSeries: readonly FrequencyDomainChartSeries[],
  xLabel: string,
): EChartsOption {
  const renderSeries = compatibleChartSeries(chartSeries);
  const resolvedXLabel = resolveSeriesXLabel(renderSeries, xLabel);
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
    series: renderSeries.map((entry) => ({
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
    yAxis: yValueAxis(seriesYAxisLabel(renderSeries)),
  };
}

function compatibleChartSeries(
  chartSeries: readonly FrequencyDomainChartSeries[],
): readonly FrequencyDomainChartSeries[] {
  const first = chartSeries.find((entry) => entry.points.length > 0);
  if (!first) return [];
  return chartSeries.filter(
    (entry) =>
      entry.points.length > 0 &&
      entry.quantity === first.quantity &&
      entry.unit === first.unit &&
      entry.xUnit === first.xUnit,
  );
}

function seriesYAxisLabel(
  chartSeries: readonly FrequencyDomainChartSeries[],
): string {
  const first = chartSeries[0];
  if (!first) return "response";
  return first.unit ? `${first.label} [${first.unit}]` : first.label;
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
      const xValue = Array.isArray(items[0]?.value)
        ? formatNumber(items[0]!.value[0] as number)
        : String(items[0]?.value ?? "");
      const lines = [`<strong>${axisLabel}: ${xValue}</strong>`];
      for (const item of items) {
        const yValue = Array.isArray(item.value)
          ? formatNumber(item.value[1] as number)
          : typeof item.value === "number"
            ? formatNumber(item.value)
            : String(item.value);
        lines.push(`${item.marker ?? ""}${item.seriesName}: ${yValue}`);
      }
      return lines.join("<br/>");
    },
  };
}
