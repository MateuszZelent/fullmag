import type { ECharts } from "echarts";

interface ChartDiagnosticsSnapshot {
  activeInstances: number;
  createdInstances: number;
  disposedInstances: number;
  dispatchDataZoom?: (fromValue: number, toValue: number) => void;
  dispatchPointClick?: (seriesIndex: number, dataIndex: number) => void;
  dispatchSeriesRequest?: (columnId: string) => void;
  lastRenderedClick?: {
    data: readonly unknown[] | null;
    dataIndex: number | null;
    seriesIndex: number | null;
    sourceRowIndex: number | null;
  };
  rangeSelectedEvents?: Array<{
    chartId: string;
    range: { fromValue: number; toValue: number } | null;
    tableId: string;
    xAxisId: string;
  }>;
  seriesSelectedEvents?: Array<{
    chartId: string;
    quantity: string;
    resourceKey: string;
    seriesId: string;
    tableId: string;
  }>;
  modelBuilds: number;
  plannedPoints: number;
  readRenderedOption?: () => unknown;
  resolveRenderedDataPoint?: (
    seriesIndex: number,
    dataIndex: number,
  ) => {
    data: readonly (number | null)[];
    dataIndex: number;
    seriesIndex: number;
    x: number;
    y: number;
  } | null;
  renderedPoints: number;
  resizeCalls: number;
  setOptionCalls: number;
}

let renderedOptionOwner: object | null = null;
let renderedClickOwner: object | null = null;

declare global {
  interface Window {
    __FULLMAG_CHART_DIAGNOSTICS__?: ChartDiagnosticsSnapshot;
    __FULLMAG_ENABLE_CHART_DIAGNOSTICS__?: boolean;
  }
}

function chartDiagnostics(): ChartDiagnosticsSnapshot | null {
  if (
    typeof window === "undefined" ||
    window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__ !== true
  ) {
    return null;
  }
  window.__FULLMAG_CHART_DIAGNOSTICS__ ??= {
    activeInstances: 0,
    createdInstances: 0,
    disposedInstances: 0,
    modelBuilds: 0,
    plannedPoints: 0,
    renderedPoints: 0,
    resizeCalls: 0,
    setOptionCalls: 0,
  };
  return window.__FULLMAG_CHART_DIAGNOSTICS__;
}

export function recordChartInstanceCreated(): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.activeInstances += 1;
  diagnostics.createdInstances += 1;
}

export function recordChartInstanceDisposed(): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.activeInstances = Math.max(0, diagnostics.activeInstances - 1);
  diagnostics.disposedInstances += 1;
  delete diagnostics.dispatchDataZoom;
  delete diagnostics.dispatchPointClick;
  delete diagnostics.dispatchSeriesRequest;
}

export function recordChartDispatchDataZoom(chart: ECharts): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.dispatchDataZoom = (fromValue, toValue) => {
    chart.dispatchAction({
      endValue: toValue,
      startValue: fromValue,
      type: "dataZoom",
    });
  };
}

export function recordChartDispatchPointClick(
  dispatchPointClick: (seriesIndex: number, dataIndex: number) => void,
): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.dispatchPointClick = dispatchPointClick;
}

export function recordChartDispatchSeriesRequest(
  dispatchSeriesRequest: (columnId: string) => void,
): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.dispatchSeriesRequest = dispatchSeriesRequest;
}

export function clearChartDispatchSeriesRequest(): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  delete diagnostics.dispatchSeriesRequest;
}

export function recordChartRangeSelectedEvent(event: {
  chartId: string;
  range: { fromValue: number; toValue: number } | null;
  tableId: string;
  xAxisId: string;
}): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.rangeSelectedEvents ??= [];
  diagnostics.rangeSelectedEvents.push(event);
  if (diagnostics.rangeSelectedEvents.length > 8) {
    diagnostics.rangeSelectedEvents.splice(
      0,
      diagnostics.rangeSelectedEvents.length - 8,
    );
  }
}

export function recordChartSeriesSelectedEvent(event: {
  chartId: string;
  quantity: string;
  resourceKey: string;
  seriesId: string;
  tableId: string;
}): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.seriesSelectedEvents ??= [];
  diagnostics.seriesSelectedEvents.push(event);
  if (diagnostics.seriesSelectedEvents.length > 8) {
    diagnostics.seriesSelectedEvents.splice(
      0,
      diagnostics.seriesSelectedEvents.length - 8,
    );
  }
}

export function recordChartResize(): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.resizeCalls += 1;
}

export function recordChartModelBuilt(
  input:
    | readonly { points: readonly unknown[] }[]
    | { series: readonly { points: readonly unknown[] }[] },
): void {
  const series = "series" in input ? input.series : input;
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  const pointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  diagnostics.modelBuilds += 1;
  diagnostics.plannedPoints += pointCount;
  diagnostics.renderedPoints = pointCount;
}

/** Observe the actual ECharts option and click event only in opt-in smoke runs. */
export function registerRenderedChartDiagnostics(chart: ECharts): () => void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return () => undefined;

  const owner = {};
  const readRenderedOption = () => chart.getOption();
  const resolveRenderedDataPoint = (seriesIndex: number, dataIndex: number) => {
    if (
      !Number.isInteger(seriesIndex) || seriesIndex < 0 ||
      !Number.isInteger(dataIndex) || dataIndex < 0
    ) {
      return null;
    }
    const option = chart.getOption() as unknown as {
      series?: Array<{ data?: unknown[] }>;
    };
    const point = option.series?.[seriesIndex]?.data?.[dataIndex];
    if (!Array.isArray(point) || point.length < 2) return null;
    const pixel = chart.convertToPixel({ seriesIndex }, point);
    if (
      !Array.isArray(pixel) ||
      typeof pixel[0] !== "number" || !Number.isFinite(pixel[0]) ||
      typeof pixel[1] !== "number" || !Number.isFinite(pixel[1])
    ) {
      return null;
    }
    const bounds = chart.getDom().getBoundingClientRect();
    if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) return null;
    return {
      data: point.slice(0, 3).map((value) =>
        typeof value === "number" || value === null ? value : null,
      ),
      dataIndex,
      seriesIndex,
      x: bounds.left + pixel[0],
      y: bounds.top + pixel[1],
    };
  };
  const onClick = (event: unknown) => {
    const record = event && typeof event === "object"
      ? event as Record<string, unknown>
      : null;
    if (!record) return;
    const data = Array.isArray(record.data)
      ? record.data.slice(0, 3).map((value) =>
          typeof value === "number" || value === null ? value : null,
        )
      : null;
    const sourceRowIndex = data?.[2];
    diagnostics.lastRenderedClick = {
      data,
      dataIndex: diagnosticIndex(record.dataIndex),
      seriesIndex: diagnosticIndex(record.seriesIndex),
      sourceRowIndex:
        typeof sourceRowIndex === "number" && Number.isInteger(sourceRowIndex)
          ? sourceRowIndex
          : null,
    };
    renderedClickOwner = owner;
  };

  chart.on("click", onClick);
  diagnostics.readRenderedOption = readRenderedOption;
  diagnostics.resolveRenderedDataPoint = resolveRenderedDataPoint;
  renderedOptionOwner = owner;

  return () => {
    chart.off("click", onClick);
    if (renderedOptionOwner === owner) {
      delete diagnostics.readRenderedOption;
      delete diagnostics.resolveRenderedDataPoint;
      renderedOptionOwner = null;
    }
    if (renderedClickOwner === owner) {
      delete diagnostics.lastRenderedClick;
      renderedClickOwner = null;
    }
  };
}

function diagnosticIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function recordChartSetOption(): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.setOptionCalls += 1;
}
