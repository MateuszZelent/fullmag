import type { EChartsOption } from "echarts";

import {
  axisScaleFromExtrema,
  detectAxisScale,
  formatAxisNameWithScale,
  formatScaledTooltipValue,
  sanitizeLabelText,
  scaledAxisLabelFormatter,
  type AxisScale,
} from "./scientificChartFormatting";
import {
  DEFAULT_CHART_TOKENS,
  type FullmagChartTokens,
} from "./fullmagChartTokens";
import type { ChartScientificTrust } from "./chartScientificTrust";

export type ChartRenderStatus =
  | "loading"
  | "ready"
  | "stale"
  | "unsupported"
  | "empty"
  | "degraded"
  | "error"
  | "aborted";

export interface ChartRenderPoint {
  rowIndex: number;
  x: number;
  y: number;
}

export interface ChartRenderSeries {
  id: string;
  kind: "line" | "scatter";
  label: string;
  points: readonly ChartRenderPoint[];
  unit: string;
  yAxis: number;
}

export interface ChartRenderModel {
  ariaLabel: string;
  droppedPointCount?: number;
  key: string;
  provenance?: {
    dataRevision: string | number | null;
    decimation: string;
    descriptorId?: string;
    displayUnits?: Record<string, string>;
    query: string;
    resourceKey: string;
    sessionId?: string | null;
    runId?: string | null;
    stageId?: string | null;
    backend?: string | null;
    device?: string | null;
    precision?: string | null;
    scientificTrust?: ChartScientificTrust;
  };
  series: readonly ChartRenderSeries[];
  status: ChartRenderStatus;
  statusMessage?: string;
  xAxis: { label: string; unit: string };
  yAxes: readonly { label: string; unit: string }[];
}

export type ChartRendererEventName = "click" | "dblclick" | "dataZoom" | "legendselectchanged";

export interface ChartRendererInstance {
  dispatchAction?(action: { type: string; start?: number; end?: number }): void;
  dispose(): void;
  getDataURL(options?: { pixelRatio?: number; type?: string }): string;
  off?(name: ChartRendererEventName, listener: (event: unknown) => void): void;
  on?(name: ChartRendererEventName, listener: (event: unknown) => void): void;
  resize(): void;
  setOption(option: EChartsOption, notMerge?: boolean): void;
}

export interface ChartRendererEngine {
  init(element: HTMLElement): ChartRendererInstance;
}

export interface ChartRendererListeners {
  click?: (event: unknown) => void;
  dblclick?: (event: unknown) => void;
  dataZoom?: (event: unknown) => void;
  legendselectchanged?: (event: unknown) => void;
}

export interface ChartRendererOwner {
  dispose(): void;
  exportPng(): string | null;
  fitView(): void;
  mount(element: HTMLElement): void;
  resize(): void;
  update(model: ChartRenderModel, tokens?: FullmagChartTokens): void;
}

export function createChartRendererOwner(
  engine: ChartRendererEngine,
  listeners: ChartRendererListeners = {},
): ChartRendererOwner {
  let chart: ChartRendererInstance | null = null;
  let disposed = false;
  const entries = Object.entries(listeners) as [
    ChartRendererEventName,
    (event: unknown) => void,
  ][];
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (chart) {
        for (const [name, listener] of entries) chart.off?.(name, listener);
        chart.dispose();
      }
      chart = null;
    },
    exportPng() {
      return disposed || !chart
        ? null
        : chart.getDataURL({ pixelRatio: 2, type: "png" });
    },
    fitView() {
      if (!disposed && chart) {
        chart.dispatchAction?.({ type: "dataZoom", start: 0, end: 100 });
      }
    },
    mount(element) {
      if (disposed || chart) return;
      chart = engine.init(element);
      for (const [name, listener] of entries) chart.on?.(name, listener);
    },
    resize() {
      if (!disposed) chart?.resize();
    },
    update(model, tokens) {
      if (!disposed && chart)
        chart.setOption(chartRenderModelToEChartsOption(model, tokens), false);
    },
  };
}

// ===== Scale computation =====

function computeXScale(model: ChartRenderModel): AxisScale {
  return detectAxisScale(iterateXValues(model.series));
}

function computeYScales(model: ChartRenderModel): AxisScale[] {
  const extrema = Array.from({ length: chartYAxisCount(model.series) }, () => ({
    absMax: 0,
    absMin: Number.POSITIVE_INFINITY,
    hasFiniteNonZeroValue: false,
  }));
  for (const series of model.series) {
    const axis = extrema[series.yAxis];
    if (!axis) continue;
    for (const point of series.points) {
      if (!Number.isFinite(point.y) || point.y === 0) continue;
      const magnitude = Math.abs(point.y);
      axis.absMax = Math.max(axis.absMax, magnitude);
      axis.absMin = Math.min(axis.absMin, magnitude);
      axis.hasFiniteNonZeroValue = true;
    }
  }
  return extrema.map((axis) =>
    axisScaleFromExtrema(axis.absMin, axis.absMax, axis.hasFiniteNonZeroValue),
  );
}

function chartYAxisCount(series: readonly ChartRenderSeries[]): number {
  let count = 1;
  for (const entry of series) count = Math.max(count, entry.yAxis + 1);
  return count;
}

function* iterateXValues(series: readonly ChartRenderSeries[]): Iterable<number> {
  for (const entry of series) {
    for (const point of entry.points) yield point.x;
  }
}

/**
 * Converts a neutral ChartRenderModel to ECharts options.
 *
 * Key invariants:
 * - `animation: false` for data updates; `animationDuration: 300` for series show/hide.
 * - `sampling` is NEVER set; data is already server-decimated (minmax_lttb).
 * - The external Fullmag legend is the single series-visibility owner.
 * - Tooltip formatter is plain-text only; no raw HTML from series names.
 * - Axis labels use auto-scaling: SI prefix is extracted from data range and moved
 *   to the axis name. Tick labels become clean numbers (1, 2, 3 ns, not 1e-9, 2e-9).
 * - Canvas receives resolved token values, never CSS variable strings.
 */
export function chartRenderModelToEChartsOption(
  model: ChartRenderModel,
  tokens?: FullmagChartTokens,
): EChartsOption {
  const resolvedTokens = tokens ?? DEFAULT_CHART_TOKENS;
  const palette = resolvedTokens.palette;

  // Compute Y-axis count from series
  const yAxisCount = chartYAxisCount(model.series);
  const yAxes = model.yAxes.length > 0 ? model.yAxes : [{ label: "", unit: "" }];

  // Auto-scale axes
  const xScale = computeXScale(model);
  const yScales = computeYScales(model);

  const textMuted = resolvedTokens.textMuted;
  const textPrimary = resolvedTokens.textPrimary;
  const fontFamily = resolvedTokens.fontFamily;
  const borderStrong = resolvedTokens.borderStrong;
  const borderSubtle = resolvedTokens.borderSubtle;
  const bgSurface = resolvedTokens.bgSurface;

  return {
    // Live data: no animation on updates. Series hide/show done by filtering series array externally.
    animation: false,

    color: [...palette],
    aria: { enabled: true, decal: { show: false } },

    dataZoom: [
      {
        filterMode: "none",
        type: "inside",
        zoomOnMouseWheel: "ctrl",
      },
    ],

    grid: {
      bottom: 48,
      containLabel: true,
      left: 8,
      right: yAxisCount > 1 ? 60 : 20,
      top: 32,
    },

    // External ChartLegend component is the single source of truth for series
    // visibility — it filters the series array before passing to ECharts.
    // ECharts built-in legend is DISABLED to prevent independent toggling.
    legend: { show: false },

    series: model.series.map((series) => ({
      // NOTE: No `sampling` property — data is already server-decimated.
      data: series.points.map((point) => [point.x, point.y, point.rowIndex]),
      emphasis: {
        lineStyle: { width: 3 },
        scale: false,
      },
      lineStyle: { width: 1.5 },
      name: sanitizeLabelText(
        series.unit
          ? `${series.label} [${series.unit}]`
          : series.label,
      ),
      progressive: 0,
      showSymbol: series.kind === "scatter",
      symbol: series.kind === "scatter" ? "circle" : "none",
      symbolSize: 4,
      type: series.kind,
      yAxisIndex: series.yAxis,
    })),

    tooltip: {
      backgroundColor: bgSurface,
      borderColor: borderStrong,
      borderWidth: 1,
      // Plain-text formatter with auto-scaled values
      formatter: (params: unknown) => {
        if (!Array.isArray(params) || params.length === 0) return "";
        const first = params[0] as { axisValue?: unknown; data?: unknown[] };
        const rawXVal = typeof first.axisValue === "number" ? first.axisValue : null;
        const xVal = rawXVal !== null
          ? formatScaledTooltipValue(rawXVal, model.xAxis.unit, xScale)
          : sanitizeLabelText(String(first.axisValue ?? ""));
        const lines: string[] = [
          `${sanitizeLabelText(model.xAxis.label || "x")}: ${xVal}`,
        ];
        for (const p of params as Array<{
          seriesName?: string;
          value?: unknown[];
        }>) {
          const rawYVal = Array.isArray(p.value) && typeof p.value[1] === "number" ? p.value[1] : null;
          const seriesMatch = model.series.find((s) => sanitizeLabelText(s.unit ? `${s.label} [${s.unit}]` : s.label) === p.seriesName);
          const axisIndex = seriesMatch?.yAxis ?? 0;
          const yScale = yScales[axisIndex] ?? { factor: 1, prefix: "" };
          const yUnit = seriesMatch?.unit ?? "";
          const yVal = rawYVal !== null
            ? formatScaledTooltipValue(rawYVal, yUnit, yScale)
            : Array.isArray(p.value)
            ? String(p.value[1] ?? "—")
            : "—";
          lines.push(`  ${sanitizeLabelText(p.seriesName ?? "")}: ${yVal}`);
        }
        const rowId = Array.isArray(first.data) ? first.data[2] : undefined;
        if (typeof rowId === "number" || typeof rowId === "string") {
          lines.push(`row id: ${sanitizeLabelText(rowId)}`);
        }
        return lines.join("\n");
      },
      padding: [6, 10],
      textStyle: {
        color: textPrimary,
        fontFamily,
        fontSize: 11,
      },
      trigger: "axis",
    },

    // ── X Axis — auto-scaled ─────────────────────────────────────────────────
    xAxis: {
      axisLabel: {
        color: textMuted,
        fontFamily,
        fontSize: 10,
        formatter: scaledAxisLabelFormatter(xScale, 4),
        hideOverlap: true,
        margin: 8,
      },
      axisLine: {
        lineStyle: { color: borderStrong },
        show: true,
      },
      axisTick: { show: false },
      name: formatAxisNameWithScale(model.xAxis.label, model.xAxis.unit, xScale),
      nameGap: 26,
      nameLocation: "middle",
      nameTextStyle: {
        color: textPrimary,
        fontFamily,
        fontSize: 11,
        fontWeight: "bold",
      },
      splitLine: { show: false },
      type: "value",
    },

    // ── Y Axes — auto-scaled per axis ────────────────────────────────────────
    yAxis: yAxes.slice(0, yAxisCount).map((axis, index) => {
      const yScale = yScales[index] ?? { factor: 1, prefix: "" };
      return {
        axisLabel: {
          color: textMuted,
          fontFamily,
          fontSize: 10,
          formatter: scaledAxisLabelFormatter(yScale, 4),
          margin: 4,
        },
        axisLine: { show: false },
        axisTick: { show: false },
        name: formatAxisNameWithScale(axis.label, axis.unit, yScale),
        nameGap: 8,
        nameLocation: "end",
        nameTextStyle: {
          align: index === 0 ? "left" : "right",
          color: textPrimary,
          fontFamily,
          fontSize: 11,
          fontWeight: "bold",
        },
        position: index === 0 ? "left" : "right",
        splitLine: {
          lineStyle: {
            color: borderSubtle,
            type: index === 0 ? "solid" : "dashed",
          },
          show: true,
        },
        type: "value",
      };
    }),
  };
}
