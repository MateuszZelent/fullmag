import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { chartTableWindowValue, type ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import {
  descriptorForFrequencyTable,
  descriptorForSurface,
} from "@/shared/domain/analysis/analysisSurfaceDescriptor";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import {
  chartValueExtrema,
  createChartDisplayTransform,
} from "@/shared/analysis-charts/chartScalePolicy";

import type { ChartSeries, ChartValueRange, TableRowsLike } from "./chartTableModel";

export function surfaceTitle(surface: AnalysisSurface): string {
  return descriptorForSurface(surface).title;
}


export function tableRowsLike(table: ChartTableWindow | null): TableRowsLike | null {
  if (!table) return null;
  return {
    columns: table.columns,
    rowCount: table.rowCount,
    valueAt: (rowIndex, columnIndex) => chartTableWindowValue(table, rowIndex, columnIndex),
  };
}

export function tableWindowRowCount(table: ChartTableWindow | null): number { return table?.rowCount ?? 0; }
export function tableWindowTotalRows(table: ChartTableWindow): number { return table.totalRows; }
export function tableWindowCursorEnd(table: ChartTableWindow): number { return table.cursorEnd; }
export function tableWindowTableId(table: ChartTableWindow | null): string { return table?.tableId ?? "default"; }

export function formatTableSummary(table: ChartTableWindow | null, status: string): string {
  return table ? `${table.totalRows} rows / ${table.columns.length} columns` : status;
}

export function formatRange(range: ChartValueRange): string {
  return `${formatRangeValue(range.fromValue)}-${formatRangeValue(range.toValue)}`;
}

export function formatRangeValue(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) return value.toExponential(3);
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

export function formatSeriesCount(count: number): string { return `${count} series`; }
export function formatCursorPoint(point: AnalysisChartCursorPoint): string { return `${point.label} ${formatLatestValue(point.point.y)}`; }

export function buildSeriesLegend(chartSeries: readonly ChartSeries[]) {
  return chartSeries.map((series) => ({
    columnId: series.id,
    label: series.label || series.quantity,
    latest: formatLatestValue(series.points.at(-1)?.y),
    series,
    source: series.source.resourceKey,
    unit: series.unit || "1",
  }));
}

export function formatXAxisLabel(chartSeries: readonly ChartSeries[], xAxisId: string): string {
  // The renderer owns unit formatting and SI scaling. Keeping this semantic
  // label unit-free prevents a stale `[s]`/`[Hz]` suffix after auto-scaling.
  return xAxisId || chartSeries.find((series) => series.xUnit)?.xUnit || "x";
}

export function formatFrequencyDomainEmptyState(status: string): string {
  if (status === "loading") return "Loading frequency-domain artifacts";
  if (status === "error") return "Frequency-domain artifacts failed to load";
  if (status === "stale") return "Frequency-domain artifacts are missing or stale";
  return "No frequency-domain series available";
}

export function buildFrequencyDomainWorkflowSummary(
  tableId: string,
  calculationMode?: string,
) {
  const descriptor = descriptorForFrequencyTable(tableId);
  if (descriptor.handoff === "mode-overlay") {
    const fmr = calculationMode === "fmr_modal";
    return {
      artifacts: "Mode fields",
      inspector: fmr ? "mode inspector" : "eigen mode inspector",
      next: "select mode to 3D overlay",
      workflow: fmr ? "FMR modal" : "Eigenmode modal",
    };
  }
  if (descriptor.handoff === "response-overlay") {
    const fmr = calculationMode === "fmr_response";
    return {
      artifacts: "Response fields",
      inspector: fmr
        ? "response point inspector"
        : "frequency response point inspector",
      next: "select frequency to response overlay",
      workflow: fmr ? "FMR driven" : "Frequency response",
    };
  }
  if (descriptor.handoff === "branch-overlay") {
    return {
      artifacts: "Mode fields",
      inspector: "dispersion point inspector",
      next: "select branch point to mode overlay",
      workflow: "Eigenmode dispersion",
    };
  }
  return null;
}

export function buildFrequencyDomainWorkbenchSummary(
  series: readonly ChartSeries[],
  calculationMode: string | undefined,
  status: string,
) {
  const first = series.find((entry) => entry.points.length > 0) ?? series[0];
  const tableId = first?.source.tableId ?? "frequency-domain";
  const descriptor = descriptorForFrequencyTable(tableId);
  const frequencyFromX = tableId === "frequency-domain:response-sweep";
  const frequencyFromY = tableId === "frequency-domain:eigen-spectrum" || tableId === "frequency-domain:eigen-dispersion";
  let pointCount = 0;
  let frequencyMin = Number.POSITIVE_INFINITY;
  let frequencyMax = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) {
      pointCount += 1;
      const frequency = frequencyFromX ? point.x : frequencyFromY ? point.y : null;
      if (frequency !== null && Number.isFinite(frequency)) {
        frequencyMin = Math.min(frequencyMin, frequency);
        frequencyMax = Math.max(frequencyMax, frequency);
      }
    }
  }
  return {
    chartKind: frequencyDomainChartKind(tableId, calculationMode),
    fieldHandoff: frequencyDomainFieldHandoff(descriptor, calculationMode),
    frequencyRange: formatFrequencyDomainWorkbenchRange(frequencyMin, frequencyMax, first),
    pointCount: `${pointCount} point${pointCount === 1 ? "" : "s"}`,
    status,
  };
}

export function buildFrequencyDomainCursorSummary(
  point: AnalysisChartCursorPoint | null,
  calculationMode: string | undefined,
  series: readonly ChartSeries[] = [],
) {
  if (!point || point.source.kind !== "analysis.frequency_domain") return null;
  const xValue = formatPointValue(
    point.point.x,
    point.xUnit,
    chartValueExtrema(iterateSeriesValues(series, "x")),
  );
  const yValue = formatPointValue(
    point.point.y,
    point.unit,
    chartValueExtrema(iterateSeriesValues(series, "y")),
  );
  const descriptor = descriptorForFrequencyTable(point.source.tableId);
  const yAxisLabel = descriptor.yAxes[0]?.label ?? point.quantity ?? "value";
  if (point.source.tableId === "frequency-domain:eigen-spectrum") {
    const fmr = calculationMode === "fmr_modal";
    return { inspectorTarget: fmr ? "FMR mode inspector and 3D overlay controls" : "Mode inspector and 3D mode controls", title: fmr ? "FMR mode" : "eigen mode", xLabel: descriptor.xAxis.label, xValue, yLabel: yAxisLabel, yValue };
  }
  if (point.source.tableId === "frequency-domain:eigen-dispersion") return { inspectorTarget: "Dispersion point inspector", linewidthValue: point.point.linewidthHz != null ? formatFrequencyHz(point.point.linewidthHz) : null, title: "dispersion point", xLabel: point.point.label ? "k-label" : descriptor.xAxis.label, xValue: point.point.label ?? xValue, yLabel: yAxisLabel, yValue };
  if (point.source.tableId === "frequency-domain:response-sweep") {
    const fmr = calculationMode === "fmr_response";
    return { inspectorTarget: fmr ? "FMR response point inspector and 3D response overlay" : "Response point inspector and 3D response controls", title: fmr ? "FMR response point" : "response point", xLabel: descriptor.xAxis.label, xValue, yLabel: point.quantity || descriptor.yAxes[0]?.label || "response", yValue };
  }
  return { inspectorTarget: "Frequency-domain inspector", title: "frequency-domain point", xLabel: "x", xValue, yLabel: point.quantity || "value", yValue };
}

export function resourceStatusFromString(status: string): ResourceStatus {
  if (status === "paused") return "ready";
  return ["idle", "loading", "ready", "stale", "error"].includes(status) ? status as ResourceStatus : "idle";
}

function frequencyDomainChartKind(tableId: string, calculationMode?: string): string {
  const descriptor = descriptorForFrequencyTable(tableId);
  if (tableId === "frequency-domain:eigen-spectrum") return calculationMode === "fmr_modal" ? "FMR modal spectrum" : descriptor.title;
  if (tableId === "frequency-domain:response-sweep") return calculationMode === "fmr_response" ? "FMR driven sweep" : descriptor.title;
  return descriptor.title;
}

function frequencyDomainFieldHandoff(
  descriptor: ReturnType<typeof descriptorForFrequencyTable>,
  calculationMode?: string,
): string {
  if (descriptor.handoff === "mode-overlay") return calculationMode === "fmr_modal" ? "select mode -> FMR 3D overlay" : "select mode -> 3D overlay";
  if (descriptor.handoff === "branch-overlay") return "select branch point -> mode overlay";
  if (descriptor.handoff === "response-overlay") return calculationMode === "fmr_response" ? "select frequency -> FMR response overlay" : "select frequency -> response overlay";
  return "select point -> inspector";
}

function formatFrequencyDomainWorkbenchRange(min: number, max: number, firstSeries: ChartSeries | undefined): string {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "not available";
  const unit = firstSeries?.source.tableId === "frequency-domain:response-sweep" ? firstSeries.xUnit : firstSeries?.unit;
  const extrema = chartValueExtrema([min, max]);
  return min === max
    ? formatPointValue(min, unit, extrema)
    : `${formatPointValue(min, unit, extrema)}-${formatPointValue(max, unit, extrema)}`;
}

function formatPointValue(
  value: number,
  unit: string | undefined,
  extrema: readonly [number, number] | null = null,
): string {
  return createChartDisplayTransform(unit ?? "", extrema).formatValue(value);
}

function* iterateSeriesValues(
  series: readonly ChartSeries[],
  coordinate: "x" | "y",
): Iterable<number> {
  for (const entry of series) {
    for (const point of entry.points) yield point[coordinate];
  }
}

export function formatLatestValue(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) return value.toExponential(3);
  const precise = value.toPrecision(5);
  return precise.includes("e") ? precise : String(Number(precise));
}
