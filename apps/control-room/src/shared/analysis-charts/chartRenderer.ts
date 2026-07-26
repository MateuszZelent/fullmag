import type { EChartsOption } from "echarts";

export type ChartRenderStatus = "loading" | "ready" | "stale" | "unsupported" | "empty" | "degraded" | "error";
export interface ChartRenderPoint { rowIndex: number; x: number; y: number }
export interface ChartRenderSeries { id: string; kind: "line" | "scatter"; label: string; points: readonly ChartRenderPoint[]; unit: string; yAxis: number }
export interface ChartRenderModel {
  ariaLabel: string;
  droppedPointCount?: number;
  key: string;
  provenance?: {
    dataRevision: string | number | null;
    decimation: string;
    query: string;
    resourceKey: string;
  };
  series: readonly ChartRenderSeries[];
  status: ChartRenderStatus;
  statusMessage?: string;
  xAxis: { label: string; unit: string };
  yAxes: readonly { label: string; unit: string }[];
}
export type ChartRendererEventName = "click" | "dblclick" | "dataZoom";
export interface ChartRendererInstance {
  dispose(): void;
  getDataURL(options?: { pixelRatio?: number; type?: string }): string;
  off?(name: ChartRendererEventName, listener: (event: unknown) => void): void;
  on?(name: ChartRendererEventName, listener: (event: unknown) => void): void;
  resize(): void;
  setOption(option: EChartsOption, notMerge?: boolean): void;
}
export interface ChartRendererEngine { init(element: HTMLElement): ChartRendererInstance }
export interface ChartRendererListeners {
  click?: (event: unknown) => void;
  dblclick?: (event: unknown) => void;
  dataZoom?: (event: unknown) => void;
}
export interface ChartRendererOwner {
  dispose(): void;
  exportPng(): string | null;
  mount(element: HTMLElement): void;
  resize(): void;
  update(model: ChartRenderModel): void;
}

export function createChartRendererOwner(
  engine: ChartRendererEngine,
  listeners: ChartRendererListeners = {},
): ChartRendererOwner {
  let chart: ChartRendererInstance | null = null;
  let disposed = false;
  const entries = Object.entries(listeners) as [ChartRendererEventName, (event: unknown) => void][];
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
      return disposed || !chart ? null : chart.getDataURL({ pixelRatio: 2, type: "png" });
    },
    mount(element) {
      if (disposed || chart) return;
      chart = engine.init(element);
      for (const [name, listener] of entries) chart.on?.(name, listener);
    },
    resize() {
      if (!disposed) chart?.resize();
    },
    update(model) {
      if (!disposed && chart) chart.setOption(chartRenderModelToEChartsOption(model), true);
    },
  };
}

export function chartRenderModelToEChartsOption(model: ChartRenderModel): EChartsOption {
  return {
    animation: false,
    dataZoom: [{ filterMode: "none", type: "inside" }, { bottom: 8, filterMode: "none", height: 12, showDetail: false, type: "slider" }],
    grid: { bottom: 56, containLabel: true, left: 16, right: 24, top: 32 },
    legend: { icon: "circle", textStyle: { color: "var(--fm-text-primary)" }, top: 0, type: "scroll" },
    series: model.series.map((series) => ({
      data: series.points.map((point) => [point.x, point.y, point.rowIndex]),
      lineStyle: { width: 2 },
      name: series.unit ? `${series.label} [${series.unit}]` : series.label,
      progressive: 0,
      showSymbol: series.kind === "scatter",
      symbolSize: 5,
      type: series.kind,
      yAxisIndex: series.yAxis,
    })),
    tooltip: { backgroundColor: "var(--fm-bg-surface)", borderColor: "var(--fm-border-strong)", textStyle: { color: "var(--fm-text-primary)" }, trigger: "axis" },
    xAxis: {
      axisLabel: { color: "var(--fm-text-muted)" },
      axisLine: { lineStyle: { color: "var(--fm-border-strong)" } },
      name: model.xAxis.label,
      nameGap: 28,
      nameLocation: "middle",
      nameTextStyle: { color: "var(--fm-text-secondary)" },
      splitLine: { show: false },
      type: "value",
    },
    yAxis: model.yAxes.map((axis, index) => ({
      axisLabel: { color: "var(--fm-text-muted)" },
      axisLine: { show: false },
      name: axis.label,
      position: index === 0 ? "left" : "right",
      splitLine: { lineStyle: { color: "var(--fm-border-subtle)" }, show: true },
      type: "value",
    })),
  };
}
