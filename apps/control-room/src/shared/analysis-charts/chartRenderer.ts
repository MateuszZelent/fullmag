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

export interface ChartRenderPoint {
  branchId?: string | null;
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
  yAxes: readonly { label: string; unit: string }[];
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

interface ChartRendererDispatchAction {
  type: string;
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
}

interface ChartRendererDispatchOptions {
  flush?: boolean;
  silent?: boolean;
}

export interface ChartRendererInstance {
  dispatchAction?(action: ChartRendererDispatchAction, options?: ChartRendererDispatchOptions): void;
  dispose(): void;
  getDataURL(options?: { pixelRatio?: number; type?: string }): string;
  getOption?(): unknown;
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
  const boundEntries: [ChartRendererEventName, (event: unknown) => void][] = [];
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (chart) {
        for (const [name, listener] of boundEntries) chart.off?.(name, listener);
        chart.dispose();
      }
      boundEntries.length = 0;
      chart = null;
    },
    exportPng() {
      return disposed || !chart
        ? null
        : chart.getDataURL({ pixelRatio: 2, type: "png" });
    },
    fitView() {
      if (!disposed && chart) {
        chart.dispatchAction?.({ type: "dataZoom", start: 0, end: 100 }, { silent: true });
      }
    },
    setRange(fromValue, toValue) {
      if (!disposed && chart) {
        chart.dispatchAction?.(
          { type: "dataZoom", startValue: fromValue, endValue: toValue },
          { silent: true },
        );
      }
    },
    mount(element) {
      if (disposed || chart) return;
      chart = engine.init(element);
      for (const [name, listener] of entries) {
        const boundListener = name === "dataZoom"
          ? (event: unknown) => listener(normalizeDataZoomEvent(chart, event))
          : listener;
        boundEntries.push([name, boundListener]);
        chart.on?.(name, boundListener);
      }
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

type DataZoomRecord = Record<string, unknown>;

function asDataZoomRecord(value: unknown): DataZoomRecord | null {
  return value && typeof value === "object" ? value as DataZoomRecord : null;
}

function finiteDataZoomNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dataZoomOptions(chart: ChartRendererInstance | null): DataZoomRecord[] {
  if (!chart?.getOption) return [];
  const option = asDataZoomRecord(chart.getOption());
  if (!option) return [];
  const dataZoom = option.dataZoom;
  const entries = Array.isArray(dataZoom) ? dataZoom : dataZoom ? [dataZoom] : [];
  return entries.map(asDataZoomRecord).filter((entry): entry is DataZoomRecord => entry !== null);
}

function dataZoomOptionForEvent(
  options: readonly DataZoomRecord[],
  event: DataZoomRecord,
): DataZoomRecord | null {
  const eventId = event.dataZoomId;
  const dataZoomIndex = finiteDataZoomNumber(event.dataZoomIndex);
  const index = dataZoomIndex !== null && Number.isInteger(dataZoomIndex) && dataZoomIndex >= 0
    ? dataZoomIndex
    : null;

  if (eventId !== undefined && eventId !== null) {
    const byId = options.find((option) => option.id === eventId) ?? null;
    if (!byId) return null;
    if (index !== null && options[index] !== byId) return null;
    return byId;
  }
  if (index !== null) return options[index] ?? null;
  return options.length === 1 ? options[0] ?? null : null;
}

function normalizeDataZoomEntry(
  entry: unknown,
  options: readonly DataZoomRecord[],
): unknown {
  const record = asDataZoomRecord(entry);
  if (!record) return entry;

  // Keep value-based actions authoritative; only percentage-only user actions
  // need the calculated values exposed by ECharts' public option snapshot.
  const explicitStartValue = finiteDataZoomNumber(record.startValue);
  const explicitEndValue = finiteDataZoomNumber(record.endValue);
  if (explicitStartValue !== null && explicitEndValue !== null) return entry;
  if ("startValue" in record || "endValue" in record) return entry;

  const option = dataZoomOptionForEvent(options, record);
  if (!option) return entry;
  const startValue = finiteDataZoomNumber(option.startValue);
  const endValue = finiteDataZoomNumber(option.endValue);
  if (startValue === null || endValue === null) return entry;

  return { ...record, startValue, endValue };
}

function normalizeDataZoomEvent(chart: ChartRendererInstance | null, event: unknown): unknown {
  const record = asDataZoomRecord(event);
  if (!record) return event;
  const options = dataZoomOptions(chart);
  const batch = record.batch;
  if (Array.isArray(batch)) {
    return {
      ...record,
      batch: batch.map((entry) => normalizeDataZoomEntry(entry, options)),
    };
  }
  return normalizeDataZoomEntry(record, options);
}

// ===== Scale computation =====

function computeXScale(model: ChartRenderModel): ChartDisplayTransform {
  return createChartDisplayTransform(
    model.xAxis.unit,
    chartValueExtrema(iterateXValues(model.series)),
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
  const yScales = computeYScales(model, yAxes);
  const seriesNames = new Map(
    model.series.map((series) => [seriesDisplayName(series, yScales), series]),
  );

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
        id: "fullmag-x-window",
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
      connectNulls: false,
      data: series.points.map((point) => [point.x, point.y, point.rowIndex]),
      emphasis: {
        lineStyle: { width: 3 },
        scale: false,
      },
      lineStyle: { width: 1.5 },
      name: seriesDisplayName(series, yScales),
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
          ? xScale.formatValue(rawXVal)
          : sanitizeLabelText(String(first.axisValue ?? ""));
        const lines: string[] = [
          `${sanitizeLabelText(model.xAxis.label || "x")}: ${xVal}`,
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
