import type { DispersionChartPointMetadata } from "@/shared/domain/analysis/chartSeries";

import type { EChartsOption } from "echarts";

import {
  parseLabelAndUnit,
  sanitizeLabelText,
  scaledAxisLabelFormatter,
  type AxisScale,
} from "./scientificChartFormatting";
import {
  chartAxisName,
  chartValueExtrema,
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
  type ChartDisplayTransform,
} from "./chartScalePolicy";
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

export interface ChartRenderPoint extends DispersionChartPointMetadata {
  linewidthHz?: number | null;
  branchId?: string | null;
  breakBefore?: boolean;
  itemId?: string | null;
  rowIndex: number;
  sampleId?: string | null;
  x: number;
  y: number;
}

export interface ChartRenderResultCoordinate {
  axisId: string;
  label: string | null;
  scalarSI: number | null;
  token: string;
  vector3SI: readonly [number, number, number] | null;
}

export interface ChartRenderResultSelectionRef {
  branchId: string | null;
  itemId: string | null;
  ordinal: number;
  sampleId: string | null;
}

export interface ChartRenderSeries {
  /** Stable palette slot supplied by the model builder when visibility is filtered. */
  colorIndex?: number;
  id: string;
  kind: "line" | "scatter";
  showSymbols?: boolean;
  symbolSize?: number;
  analyticReference?: boolean;
  label: string;
  points: readonly ChartRenderPoint[];
  unit: string;
  yAxis: number;
}

export interface ChartRenderYAxis {
  /** Raw plotted y-value range, in the same units as its series data. */
  dataRange?: readonly [min: number, max: number];
  label: string;
  unit: string;
}

export interface ChartRenderModel {
  ariaLabel: string;
  droppedPointCount?: number;
  key: string;
  provenance?: {
    artifactPath?: string | null;
    contentDigest?: string | null;
    dataRevision: string | number | null;
    decimation: string;
    datasetId?: string | null;
    datasetRevision?: string | null;
    descriptorId?: string;
    displayUnits?: Record<string, string>;
    fixedCoordinates?: readonly ChartRenderResultCoordinate[];
    projectionId?: string | null;
    projectionRevision?: string | null;
    query: string;
    resourceKey: string;
    selectionRefs?: readonly ChartRenderResultSelectionRef[];
    sessionId?: string | null;
    runId?: string | null;
    stageId?: string | null;
    backend?: string | null;
    device?: string | null;
    precision?: string | null;
    provenance?: string | null;
    qualification?: string | null;
    schemaVersion?: string | null;
    scientificTrust?: ChartScientificTrust;
  };
  series: readonly ChartRenderSeries[];
  status: ChartRenderStatus;
  statusMessage?: string;
  xAxis: { label: string; unit: string };
  yAxes: readonly ChartRenderYAxis[];
}

export type ChartResultExportContext = Pick<
  NonNullable<ChartRenderModel["provenance"]>,
  | "datasetId"
  | "datasetRevision"
  | "fixedCoordinates"
  | "projectionId"
  | "projectionRevision"
  | "runId"
  | "selectionRefs"
  | "stageId"
>;

export type ChartRendererEventName = "click" | "dblclick" | "dataZoom" | "legendselectchanged";

export interface ChartRendererInstance {
  dispatchAction?(action: { type: string; start?: number; end?: number; startValue?: number; endValue?: number }): void;
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
  setRange(fromValue: number, toValue: number): void;
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
    setRange(fromValue, toValue) {
      if (!disposed && chart) {
        chart.dispatchAction?.({ type: "dataZoom", startValue: fromValue, endValue: toValue });
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

function computeXScale(model: ChartRenderModel): ChartDisplayTransform {
  return createChartDisplayTransform(
    model.xAxis.unit,
    chartValueExtrema(iterateXValues(model.series)),
    model.provenance?.displayUnits?.x,
  );
}

function computeYScales(
  model: ChartRenderModel,
  axes: readonly { label: string; unit: string }[],
): ChartDisplayTransform[] {
  const preferredUnits = axes.map((_, axisIndex) => {
    const requested = model.series
      .filter((series) => series.yAxis === axisIndex)
      .map((series) => model.provenance?.displayUnits?.[`y:${series.id}`])
      .filter((unit): unit is string => Boolean(unit));
    return requested.length > 0 && requested.every((unit) => unit === requested[0])
      ? requested[0]
      : null;
  });
  return createChartYAxisDisplayTransforms(axes, model.series, preferredUnits);
}

function axisScale(transform: ChartDisplayTransform): AxisScale {
  return { factor: transform.factor, prefix: "" };
}

function seriesDisplayName(
  series: ChartRenderSeries,
  transforms: readonly ChartDisplayTransform[],
): string {
  const transform =
    transforms[series.yAxis] ?? createChartDisplayTransform(series.unit, null);
  return sanitizeLabelText(chartAxisName(series.label, transform));
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

function chartSeriesColor(
  series: ChartRenderSeries,
  visibleIndex: number,
  palette: readonly string[],
): string | undefined {
  if (palette.length === 0) return undefined;
  const explicitIndex = Number.isInteger(series.colorIndex) && series.colorIndex! >= 0
    ? series.colorIndex!
    : null;
  const index = explicitIndex ?? visibleIndex;
  return palette[index % palette.length];
}

/**
 * Converts a neutral ChartRenderModel to ECharts options.
 *
 * Key invariants:
 * - `animation: false` for data updates; `animationDuration: 300` for series show/hide.
 * - `sampling` is NEVER set; data is already server-decimated (minmax_lttb).
 * - The external Fullmag legend is the single series-visibility owner.
 * - Tooltip formatter is plain-text only; no raw HTML from series names.
 * - Series colors honor explicit model slots, so external legend filtering cannot renumber them.
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
  const yScales = computeYScales(model, yAxes);
  const seriesNames = new Map(
    model.series.map((series) => [seriesDisplayName(series, yScales), series]),
  );

  const pointsBySeriesName = new Map(model.series.map((series) => [
    seriesDisplayName(series, yScales), new Map(series.points.map((point) => [point.rowIndex, point])),
  ]));

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

    series: model.series.map((series, visibleIndex) => {
      const color = chartSeriesColor(series, visibleIndex, palette);
      const symbolSize = series.symbolSize ?? 4;
      return {
        // NOTE: No `sampling` property — data is already server-decimated.
        connectNulls: false,
        data: series.points.flatMap<Array<number | null> | { value: number[]; symbol: string; symbolSize: number; itemStyle: { borderColor: string; borderWidth: number } }>((point) => [
          ...(series.kind === "line" && point.breakBefore
            ? [[point.x, null, null]]
            : []),
          point.selected
            ? { value: [point.x, point.y, point.rowIndex], symbol: series.analyticReference ? "diamond" : "circle", symbolSize: Math.max(symbolSize, 10), itemStyle: { borderColor: textPrimary, borderWidth: 2 } }
            : [point.x, point.y, point.rowIndex],
        ]),
        emphasis: {
          lineStyle: { color, width: 3 },
          scale: false,
        },
        itemStyle: color ? { color } : undefined,
        lineStyle: { color, width: 1.5, ...(series.analyticReference ? { type: "dashed" } : {}) },
        name: seriesDisplayName(series, yScales),
        progressive: 0,
        showSymbol: series.analyticReference || series.kind === "scatter" || series.showSymbols || series.points.some((point) => point.selected),
        symbol: series.analyticReference ? "diamond" : series.kind === "scatter" || series.showSymbols ? "circle" : "none",
        symbolSize,
        type: series.kind,
        yAxisIndex: series.yAxis,
      };
    }),

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
          ? xScale.formatValue(rawXVal)
          : sanitizeLabelText(String(first.axisValue ?? ""));
        const lines: string[] = [
          `${sanitizeLabelText(model.xAxis.unit === "rad/m" ? parseLabelAndUnit(model.xAxis.label || "x", model.xAxis.unit).baseLabel : model.xAxis.label || "x")}: ${xVal}`,
        ];
        for (const p of params as Array<{
          seriesName?: string;
          value?: unknown[];
        }>) {
          const rawYVal = Array.isArray(p.value) && typeof p.value[1] === "number" ? p.value[1] : null;
          const seriesMatch = seriesNames.get(p.seriesName ?? "");
          const axisIndex = seriesMatch?.yAxis ?? 0;
          const yScale = yScales[axisIndex] ?? createChartDisplayTransform("", null);
          const yVal = rawYVal !== null
            ? yScale.formatValue(rawYVal)
            : Array.isArray(p.value)
            ? String(p.value[1] ?? "—")
            : "—";
          lines.push(`  ${sanitizeLabelText(p.seriesName ?? "")}: ${yVal}`);
          const row = Array.isArray(p.value) ? p.value[2] : undefined;
          const point = typeof row === "number" ? pointsBySeriesName.get(p.seriesName ?? "")?.get(row) : undefined;
          if (point?.wavevectorRadPerM?.every(Number.isFinite)) {
            const labels = ["kₓ", "kᵧ", "k_z"];
            lines.push(point.wavevectorRadPerM.map((value, index) =>
              `${labels[index]} = ${formatDispersionValue(value / 1e6)} rad/µm`,
            ).join(" · "));
          }
          if (point?.modeIndex != null) {
            lines.push(`mode ${point.modeIndex + 1}${point.sampleIndex == null ? "" : ` · sample ${point.sampleIndex + 1}`}${point.modeFieldAvailable === undefined ? "" : point.modeFieldAvailable ? " · 3D field available" : " · 3D field unavailable"}`);
          }
          if (point?.residualNorm != null && Number.isFinite(point.residualNorm)) {
            lines.push(`reported residual: ${point.residualNorm.toExponential(3)}`);
          }
          if (point?.linewidthHz != null && Number.isFinite(point.linewidthHz)) {
            lines.push(`linewidth: ${formatDispersionValue(point.linewidthHz / 1e6)} MHz`);
          }
        }
        const rowId = Array.isArray(first.data) ? first.data[2] : undefined;
        const scientificPoint = typeof rowId === "number" && (params as Array<{ seriesName?: string }>).some((item) => pointsBySeriesName.get(item.seriesName ?? "")?.get(rowId)?.modeIndex != null);
        if (!scientificPoint && (typeof rowId === "number" || typeof rowId === "string")) {
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
        formatter: scaledAxisLabelFormatter(axisScale(xScale), 4),
        hideOverlap: true,
        margin: 8,
      },
      axisLine: {
        lineStyle: { color: borderStrong },
        show: true,
      },
      axisTick: { show: false },
      name: chartAxisName(
        parseLabelAndUnit(model.xAxis.label, model.xAxis.unit).baseLabel,
        xScale,
      ),
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
      const yScale = yScales[index] ?? createChartDisplayTransform(axis.unit, null);
      return {
        ...(axis.dataRange
          ? { max: axis.dataRange[1], min: axis.dataRange[0], scale: true }
          : {}),
        axisLabel: {
          color: textMuted,
          fontFamily,
          fontSize: 10,
          formatter: scaledAxisLabelFormatter(axisScale(yScale), 4),
          margin: 4,
        },
        axisLine: { show: false },
        axisTick: { show: false },
        name: chartAxisName(parseLabelAndUnit(axis.label, axis.unit).baseLabel, yScale),
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

function formatDispersionValue(value: number): string {
  return Number(value.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 });
}
