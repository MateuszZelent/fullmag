import type { ECharts } from "echarts";

interface ChartDiagnosticsSnapshot {
  activeInstances: number;
  createdInstances: number;
  disposedInstances: number;
  dispatchDataZoom?: (fromValue: number, toValue: number) => void;
  dispatchPointClick?: (seriesIndex: number, dataIndex: number) => void;
  dispatchSeriesRequest?: (columnId: string) => void;
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
  renderedPoints: number;
  resizeCalls: number;
  setOptionCalls: number;
}

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

export function recordChartSetOption(): void {
  const diagnostics = chartDiagnostics();
  if (!diagnostics) return;
  diagnostics.setOptionCalls += 1;
}
